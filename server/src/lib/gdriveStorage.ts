/**
 * Google Drive Depolama Sağlayıcısı — AES-256-GCM şifreleme ile.
 *
 * Mimari:
 *   - Admin, OAuth 2.0 akışıyla bir veya daha fazla Gmail hesabını yetkilendirir.
 *   - Her Gmail hesabı bir "bucket" gibi davranır; round-robin yük dağıtımı storageProvider.ts üzerinde yapılır.
 *   - Dosyalar, yetkili Drive'da "FileSplit Storage" adlı bir klasörde saklanır.
 *   - Chunk'ların Drive dosya ID'leri Firebase (veya yerel fallback) üzerinde tutulur.
 *   - Access token'lar bellekte önbelleğe alınır; refresh token'lar Firebase/yerel depoda saklanır.
 *
 * Güvenlik:
 *   - Scope: yalnızca drive.file (bu uygulama tarafından oluşturulan dosyalara erişim).
 *   - Refresh token'lar yalnızca sunucu tarafında tutulur, istemciye hiç gönderilmez.
 *   - Her chunk AES-256-GCM ile şifrelenir; şifreleme anahtarı Drive'a yazılmaz.
 *   - OAuth state parametresi CSRF saldırılarına karşı session'da tutulur.
 *
 * Gerekli ortam değişkenleri:
 *   GOOGLE_CLIENT_ID       — OAuth 2.0 istemci kimliği
 *   GOOGLE_CLIENT_SECRET   — OAuth 2.0 istemci sırrı
 *   GOOGLE_REDIRECT_URI    — OAuth geri dönüş URL'si (ör: https://sizin-alan.com/api/auth/gdrive/callback)
 */

import { google, type drive_v3 } from "googleapis";
import { Readable } from "stream";
import { createHash } from "crypto";
import { encryptChunk, decryptChunk } from "./r2Storage.js";
import { getFirebaseDb } from "./firebase.js";
import { logger } from "./logger.js";
import fs from "fs";
import path from "path";
import { uploadsDir, ensureUploadsDir } from "./fileStore.js";

// ── Bellek İçi Önbellekler ────────────────────────────────────────────────────

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

/** E-posta → { accessToken, expiresAt } */
const tokenCache = new Map<string, TokenCache>();

/** E-posta → Drive klasör ID'si ("FileSplit Storage") */
const folderIdCache = new Map<string, string>();

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function emailToKey(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

// ── Hesap Depolama (Firebase veya Yerel) ─────────────────────────────────────

interface DriveAccount {
  email: string;
  refreshToken: string;
  authorizedAt: string;
}

function getLocalAccountsPath(): string {
  ensureUploadsDir();
  return path.join(uploadsDir, "_gdrive_accounts.json");
}

function loadLocalAccounts(): DriveAccount[] {
  const p = getLocalAccountsPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as DriveAccount[];
  } catch {
    return [];
  }
}

function saveLocalAccountsFile(accounts: DriveAccount[]): void {
  fs.writeFileSync(getLocalAccountsPath(), JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

async function loadAllAccounts(): Promise<DriveAccount[]> {
  // Env-var tabanlı statik hesabı her zaman listeye ekle
  const envAccount = getEnvAccount();
  const envList: DriveAccount[] = envAccount ? [envAccount] : [];

  const db = getFirebaseDb();
  if (db) {
    try {
      const snap = await db.ref("googleDriveAccounts").get();
      if (!snap.exists()) return envList;
      const result: DriveAccount[] = [];
      snap.forEach((child) => {
        const val = child.val() as DriveAccount | null;
        if (val?.email && val?.refreshToken) result.push(val);
      });
      // Env hesabı varsa aynı email tekrar eklenmez
      const merged = [...envList];
      for (const acc of result) {
        if (!merged.some((e) => e.email === acc.email)) merged.push(acc);
      }
      return merged;
    } catch (err) {
      logger.error({ err }, "GDrive: Firebase hesap listesi okunamadı");
    }
  }

  const local = loadLocalAccounts();
  const merged = [...envList];
  for (const acc of local) {
    if (!merged.some((e) => e.email === acc.email)) merged.push(acc);
  }
  return merged;
}

async function persistAccount(account: DriveAccount): Promise<void> {
  const db = getFirebaseDb();
  const key = emailToKey(account.email);
  if (db) {
    try {
      await db.ref(`googleDriveAccounts/${key}`).set(account);
      return;
    } catch (err) {
      logger.error({ err }, "GDrive: Firebase hesap kaydedilemedi");
    }
  }
  const accounts = loadLocalAccounts().filter((a) => a.email !== account.email);
  accounts.push(account);
  saveLocalAccountsFile(accounts);
}

async function deletePersistedAccount(email: string): Promise<void> {
  const db = getFirebaseDb();
  const key = emailToKey(email);
  if (db) {
    try {
      await db.ref(`googleDriveAccounts/${key}`).remove();
    } catch (err) {
      logger.error({ err }, "GDrive: Firebase hesap silinemedi");
    }
    return;
  }
  const accounts = loadLocalAccounts().filter((a) => a.email !== email);
  saveLocalAccountsFile(accounts);
}

// ── Drive Chunk ID Depolama ───────────────────────────────────────────────────

interface ChunkEntry {
  driveFileId: string;
  email: string;
}

function getLocalChunksPath(): string {
  ensureUploadsDir();
  return path.join(uploadsDir, "_gdrive_chunks.json");
}

async function storeChunkDriveId(
  fileId: string,
  chunkIndex: number,
  driveFileId: string,
  email: string,
): Promise<void> {
  const db = getFirebaseDb();
  const fileHash = createHash("sha256").update(fileId).digest("hex");
  const entry: ChunkEntry = { driveFileId, email };

  if (db) {
    try {
      await db.ref(`driveChunks/${fileHash}/${chunkIndex}`).set(entry);
      return;
    } catch (err) {
      logger.error({ err }, "GDrive: chunk ID Firebase'e kaydedilemedi");
    }
  }

  const p = getLocalChunksPath();
  let data: Record<string, Record<string, ChunkEntry>> = {};
  if (fs.existsSync(p)) {
    try {
      data = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, Record<string, ChunkEntry>>;
    } catch {
      data = {};
    }
  }
  if (!data[fileHash]) data[fileHash] = {};
  data[fileHash]![chunkIndex] = entry;
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function getChunkDriveId(fileId: string, chunkIndex: number): Promise<ChunkEntry | null> {
  const db = getFirebaseDb();
  const fileHash = createHash("sha256").update(fileId).digest("hex");

  if (db) {
    try {
      const snap = await db.ref(`driveChunks/${fileHash}/${chunkIndex}`).get();
      if (snap.exists()) return snap.val() as ChunkEntry;
    } catch (err) {
      logger.error({ err }, "GDrive: chunk ID Firebase'den okunamadı");
    }
  }

  const p = getLocalChunksPath();
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, Record<string, ChunkEntry>>;
    return data[fileHash]?.[chunkIndex] ?? null;
  } catch {
    return null;
  }
}

async function removeAllChunkIds(fileId: string): Promise<void> {
  const db = getFirebaseDb();
  const fileHash = createHash("sha256").update(fileId).digest("hex");

  if (db) {
    try {
      await db.ref(`driveChunks/${fileHash}`).remove();
    } catch (err) {
      logger.error({ err }, "GDrive: chunk ID'leri Firebase'den silinemedi");
    }
    return;
  }

  const p = getLocalChunksPath();
  if (!fs.existsSync(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    delete data[fileHash];
    fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

// ── OAuth2 İstemcisi ──────────────────────────────────────────────────────────

function getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  const redirectUri = process.env["GOOGLE_REDIRECT_URI"];

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth2 yapılandırması eksik " +
        "(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)",
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isGDriveOAuthConfigured(): boolean {
  return !!(
    process.env["GOOGLE_CLIENT_ID"] &&
    process.env["GOOGLE_CLIENT_SECRET"] &&
    process.env["GOOGLE_REDIRECT_URI"]
  );
}

// ── Access Token Yönetimi ─────────────────────────────────────────────────────

/**
 * Belirtilen e-posta için geçerli bir access token döner.
 * Önce bellekteki önbelleği kontrol eder; süresi dolmuşsa refresh token ile yeniler.
 */
async function getAccessToken(email: string): Promise<string> {
  const cached = tokenCache.get(email);
  // 60 saniyelik emniyet marjı
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const accounts = await loadAllAccounts();
  const account = accounts.find((a) => a.email === email);
  if (!account) {
    throw new Error(`GDrive: Yetkilendirilmiş hesap bulunamadı: ${email}`);
  }

  // Env-var hesabı için REDIRECT_URI şart değil — sadece clientId + clientSecret yeter
  const clientId = process.env["GOOGLE_CLIENT_ID"]!;
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"]!;
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: account.refreshToken });

  const tokenRes = await auth.getAccessToken();
  if (!tokenRes.token) {
    throw new Error(`GDrive: Access token alınamadı (${email})`);
  }

  tokenCache.set(email, {
    accessToken: tokenRes.token,
    expiresAt: Date.now() + 55 * 60 * 1000, // ~55 dakika
  });

  return tokenRes.token;
}

function buildDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

// ── FileSplit Storage Klasörü ─────────────────────────────────────────────────

const DRIVE_FOLDER_NAME = "FileSplit Storage";

/**
 * Drive'daki "FileSplit Storage" klasörünün ID'sini döner.
 * Klasör yoksa oluşturur; ID önbellekte tutulur.
 */
async function getOrCreateFileSplitFolder(drive: drive_v3.Drive, email: string): Promise<string> {
  const cached = folderIdCache.get(email);
  if (cached) return cached;

  const listRes = await drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
    spaces: "drive",
  });

  if (listRes.data.files && listRes.data.files.length > 0) {
    const folderId = listRes.data.files[0]!.id!;
    folderIdCache.set(email, folderId);
    return folderId;
  }

  const createRes = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  const folderId = createRes.data.id!;
  folderIdCache.set(email, folderId);
  logger.info({ email, folderId }, `GDrive: "${DRIVE_FOLDER_NAME}" klasörü oluşturuldu`);
  return folderId;
}

// ── Dışa Açılan API ───────────────────────────────────────────────────────────

/** Yetkilendirilmiş hesapların genel bilgilerini döner (refresh token dahil değil). */
export async function listAuthorizedAccounts(): Promise<{ email: string; authorizedAt: string }[]> {
  const accounts = await loadAllAccounts();
  return accounts.map(({ email, authorizedAt }) => ({ email, authorizedAt }));
}

// ── Env-var Tabanlı Statik Hesap ─────────────────────────────────────────────
// GDRIVE_REFRESH_TOKEN + GDRIVE_EMAIL tanımlıysa, bu hesap her zaman aktiftir.
// Admin panelinden OAuth yapmaya gerek yoktur.

const ENV_ACCOUNT_SENTINEL = "__env__";

/**
 * GDRIVE_REFRESH_TOKEN env var'ından statik hesabı döner.
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET gereklidir (token yenilemek için).
 */
function getEnvAccount(): DriveAccount | null {
  const refreshToken = process.env["GDRIVE_REFRESH_TOKEN"];
  const email = process.env["GDRIVE_EMAIL"] ?? ENV_ACCOUNT_SENTINEL;
  const clientId = process.env["GOOGLE_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];

  if (!refreshToken || !clientId || !clientSecret) return null;
  return { email, refreshToken, authorizedAt: "env" };
}

/** Env-var hesabı aktifse true döner (OAuth panel konfigürasyonuna gerek yok). */
export function isGDriveEnvConfigured(): boolean {
  return !!(
    process.env["GDRIVE_REFRESH_TOKEN"] &&
    process.env["GOOGLE_CLIENT_ID"] &&
    process.env["GOOGLE_CLIENT_SECRET"]
  );
}

/** En az bir yetkili hesap varsa true döner. Env-var hesabı varsa hep true. */
export async function isGDriveConfigured(): Promise<boolean> {
  if (isGDriveEnvConfigured()) return true;
  if (!isGDriveOAuthConfigured()) return false;
  const accounts = await loadAllAccounts();
  return accounts.length > 0;
}

/**
 * CSRF korumalı OAuth yetkilendirme URL'si oluşturur.
 * state parametresi çağıran tarafından session'a kaydedilmeli.
 */
export function generateAuthUrl(state: string): string {
  const auth = getOAuth2Client();
  return auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    state,
  });
}

/**
 * OAuth callback'ten gelen code ile token alışverişi yapar,
 * e-posta adresini öğrenir ve refresh token'ı depoya kaydeder.
 * @returns Yetkilendirilen Gmail adresi
 */
export async function handleOAuthCallback(code: string): Promise<string> {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google refresh token göndermedi. " +
        "Lütfen önce https://myaccount.google.com/permissions adresinden " +
        "bu uygulamanın erişimini iptal edin ve tekrar yetkilendirin.",
    );
  }

  auth.setCredentials(tokens);
  const oauth2Api = google.oauth2({ version: "v2", auth });
  const userInfo = await oauth2Api.userinfo.get();
  const email = userInfo.data.email;

  if (!email) throw new Error("Google kullanıcı e-posta adresi alınamadı");

  await persistAccount({
    email,
    refreshToken: tokens.refresh_token,
    authorizedAt: new Date().toISOString(),
  });

  // Önbellekleri sıfırla — yeni token ve klasör ID'si gerekebilir
  tokenCache.delete(email);
  folderIdCache.delete(email);

  logger.info({ email }, "GDrive: Yeni hesap yetkilendirildi");
  return email;
}

/** Bir hesabın yetkisini iptal eder ve tüm önbelleklerden kaldırır. */
export async function revokeAccount(email: string): Promise<void> {
  tokenCache.delete(email);
  folderIdCache.delete(email);
  await deletePersistedAccount(email);
  logger.info({ email }, "GDrive: Hesap yetkisi kaldırıldı");
}

/**
 * Bir chunk'ı şifreleyerek belirtilen Gmail hesabının Drive'ına yükler.
 * Drive dosya ID'si Firebase/yerel depoya kaydedilir.
 */
export async function uploadChunkToGDrive(
  fileId: string,
  chunkIndex: number,
  plaintext: Buffer,
  encryptionKey: Buffer,
  accountEmail: string,
): Promise<void> {
  const accessToken = await getAccessToken(accountEmail);
  const drive = buildDriveClient(accessToken);
  const folderId = await getOrCreateFileSplitFolder(drive, accountEmail);

  const encrypted = encryptChunk(plaintext, encryptionKey);
  const fileHash = createHash("sha256").update(fileId).digest("hex");
  const fileName = `${fileHash}_chunk_${chunkIndex}.enc`;

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      appProperties: {
        filesplit_file_id: fileId,
        filesplit_chunk_index: String(chunkIndex),
      },
    },
    media: {
      mimeType: "application/octet-stream",
      body: Readable.from(encrypted),
    },
    fields: "id",
  });

  const driveFileId = response.data.id;
  if (!driveFileId) throw new Error("GDrive: Yükleme sonrası dosya ID alınamadı");

  await storeChunkDriveId(fileId, chunkIndex, driveFileId, accountEmail);
}

/**
 * Belirtilen chunk'ı Drive'dan indirir ve AES-256-GCM şifresini çözer.
 * Chunk hangi hesaba yüklendiğini Firebase/yerel depodan öğrenir.
 */
export async function downloadChunkFromGDrive(
  fileId: string,
  chunkIndex: number,
  encryptionKey: Buffer,
  _accountEmail: string,
): Promise<Buffer> {
  const chunkInfo = await getChunkDriveId(fileId, chunkIndex);
  if (!chunkInfo) {
    throw new Error(
      `GDrive: chunk_${chunkIndex} kaydı bulunamadı (dosya: ${fileId}). ` +
        "Drive chunk ID'si Firebase'de kayıtlı değil.",
    );
  }

  const accessToken = await getAccessToken(chunkInfo.email);
  const drive = buildDriveClient(accessToken);

  const response = await drive.files.get(
    { fileId: chunkInfo.driveFileId, alt: "media" },
    { responseType: "arraybuffer" },
  );

  const encrypted = Buffer.from(response.data as ArrayBuffer);
  return decryptChunk(encrypted, encryptionKey);
}

/**
 * Bir dosyanın tüm chunk'larını Drive'dan siler (best-effort).
 * Silme hataları loglanır ancak asla fırlatılmaz.
 */
export async function deleteFileChunksFromGDrive(
  fileId: string,
  chunkCount: number,
  _accountEmail: string,
): Promise<void> {
  for (let i = 0; i < chunkCount; i++) {
    try {
      const chunkInfo = await getChunkDriveId(fileId, i);
      if (!chunkInfo) continue;

      const accessToken = await getAccessToken(chunkInfo.email);
      const drive = buildDriveClient(accessToken);
      await drive.files.delete({ fileId: chunkInfo.driveFileId });
    } catch (err) {
      logger.warn({ err, fileId, chunkIndex: i }, "GDrive: chunk silme başarısız (non-fatal)");
    }
  }

  await removeAllChunkIds(fileId);
}

/**
 * Drive bağlantısını test eder: About API'yi çağırır.
 */
export async function testGDriveConnectivity(email: string): Promise<{
  success: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const accessToken = await getAccessToken(email);
    const drive = buildDriveClient(accessToken);
    await drive.about.get({ fields: "user" });
    return { success: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
