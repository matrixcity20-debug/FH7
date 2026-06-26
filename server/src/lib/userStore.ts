import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { uploadsDir, ensureUploadsDir, MAX_USER_STORAGE_BYTES, MAX_FILE_SIZE, CHUNK_SIZE } from "./fileStore.js";
import { getFirebaseDb } from "./firebase.js";
import { logger } from "./logger.js";

// Per-user limit overrides. Undefined/absent fields fall back to server defaults.
export interface UserLimits {
  storageQuotaBytes?: number;
  maxFileSizeBytes?: number;
  chunkSizeBytes?: number;
}

// Effective (resolved) limits after merging user overrides with server defaults.
export interface ResolvedLimits {
  storageQuotaBytes: number;
  maxFileSizeBytes: number;
  chunkSizeBytes: number;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  lastLoginAt?: string;
  limits?: UserLimits;
}

// Public user shape exposed to admin endpoints — never includes passwordHash.
export type PublicUser = Omit<User, "passwordHash">;

/**
 * Kullanıcı deposu — iki backend destekler:
 *
 *  1) Firebase Realtime Database (FIREBASE_* ortam değişkenleri ayarlıysa)
 *  2) Yerel JSON dosyası (uploads/_users.json) — Firebase ayarlı değilse otomatik devreye girer
 *
 * GÜVENLİK: Şifreler bu modüle ASLA düz metin olarak ulaşmaz — auth.ts
 * şifreyi bcrypt (cost 12) ile hashledikten sonra burada sadece passwordHash
 * saklanır/okunur. Firebase tarafına da yalnızca bu hash yazılır.
 *
 * Firebase RTDB anahtarları '.', '#', '$', '/', '[', ']' karakterlerini
 * içeremez; kullanıcı adında '.' karakterine izin verildiği için (bkz.
 * routes/auth.ts regex) kullanıcı adını doğrudan anahtar olarak kullanmak
 * yerine sha256 hash'ini "usernameIndex" anahtarı olarak kullanıyoruz.
 * Bu hem karakter kısıtını çözer hem de büyük/küçük harf duyarsız
 * (case-insensitive) tekil kullanıcı adı kontrolü sağlar.
 */

function usernameIndexKey(username: string): string {
  return createHash("sha256").update(username.toLowerCase()).digest("hex");
}

// BUL-17: exposed so the standalone migration script (scripts/migrate-local-
// to-firebase.ts) can compute the same index key Firebase itself uses,
// without duplicating the hashing logic.
export { usernameIndexKey };

// ---------------------------------------------------------------------------
// Yerel dosya deposu (fallback)
// ---------------------------------------------------------------------------

function getUsersFilePath(): string {
  ensureUploadsDir();
  return path.join(uploadsDir, "_users.json");
}

function loadLocalUsers(): User[] {
  const p = getUsersFilePath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as User[];
  } catch {
    return [];
  }
}

// BUL-17: read-only accessor for the migration script — lets it enumerate
// every locally-stored account without duplicating the file-parsing logic.
export function loadAllLocalUsers(): User[] {
  return loadLocalUsers();
}

function saveLocalUsers(users: User[]): void {
  fs.writeFileSync(getUsersFilePath(), JSON.stringify(users, null, 2));
}

function findUserByUsernameLocal(username: string): User | null {
  const users = loadLocalUsers();
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
}

function findUserByIdLocal(id: string): User | null {
  const users = loadLocalUsers();
  return users.find((u) => u.id === id) ?? null;
}

function createUserLocal(username: string, passwordHash: string): User {
  const users = loadLocalUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error("USERNAME_TAKEN");
  }
  // Kayıt anında ENV'den gelen sunucu varsayılanlarını kalıcı olarak sakla.
  // Böylece her kullanıcının limitleri yerel depoda da her zaman açık olur.
  const user: User = {
    id: uuidv4(),
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    limits: {
      storageQuotaBytes: MAX_USER_STORAGE_BYTES,
      maxFileSizeBytes:  MAX_FILE_SIZE,
      chunkSizeBytes:    CHUNK_SIZE,
    },
  };
  users.push(user);
  saveLocalUsers(users);
  return user;
}

// ---------------------------------------------------------------------------
// Firebase Realtime Database deposu
// ---------------------------------------------------------------------------

async function findUserByUsernameFirebase(username: string): Promise<User | null> {
  const db = getFirebaseDb();
  if (!db) return null;

  const indexSnap = await db.ref(`usernameIndex/${usernameIndexKey(username)}`).get();
  if (!indexSnap.exists()) return null;

  const userId = indexSnap.val() as string;
  const userSnap = await db.ref(`users/${userId}`).get();
  return userSnap.exists() ? (userSnap.val() as User) : null;
}

async function findUserByIdFirebase(id: string): Promise<User | null> {
  const db = getFirebaseDb();
  if (!db) return null;
  const snap = await db.ref(`users/${id}`).get();
  return snap.exists() ? (snap.val() as User) : null;
}

async function createUserFirebase(username: string, passwordHash: string): Promise<User> {
  const db = getFirebaseDb();
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");

  const id = uuidv4();
  const indexRef = db.ref(`usernameIndex/${usernameIndexKey(username)}`);

  // Aynı kullanıcı adıyla eşzamanlı kayıt denemelerine karşı atomik (transaction)
  // kontrol: anahtar hâlâ boşsa bu isteğin id'sini yaz, doluysa işlemi reddet.
  const txResult = await indexRef.transaction((current) => {
    if (current !== null) return undefined; // abort — zaten alınmış
    return id;
  });

  if (!txResult.committed) {
    throw new Error("USERNAME_TAKEN");
  }

  // Kayıt anında ENV'den gelen sunucu varsayılanlarını Firebase'e yaz.
  // Böylece her kullanıcının limitleri ilk andan itibaren Firebase'de
  // açık olarak saklanır; admin sonradan değiştirdiğinde sadece bu alanı
  // günceller (kullanıcı/şifre alanlarına dokunmaz).
  const user: User = {
    id,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    limits: {
      storageQuotaBytes: MAX_USER_STORAGE_BYTES,
      maxFileSizeBytes:  MAX_FILE_SIZE,
      chunkSizeBytes:    CHUNK_SIZE,
    },
  };

  try {
    await db.ref(`users/${id}`).set(user);
  } catch (err) {
    // Kullanıcı kaydı yazılamadıysa index'i geri al, yarım kayıt bırakma.
    await indexRef.remove().catch(() => {});
    throw err;
  }

  return user;
}

// ---------------------------------------------------------------------------
// Dışa açılan API (her zaman async — çağıran kodda await kullanın)
// ---------------------------------------------------------------------------

export async function findUserByUsername(username: string): Promise<User | null> {
  if (getFirebaseDb()) {
    try {
      return await findUserByUsernameFirebase(username);
    } catch (err) {
      logger.error({ err }, "Firebase okuma hatası (findUserByUsername), yerel depoya düşülüyor");
    }
  }
  return findUserByUsernameLocal(username);
}

export async function findUserById(id: string): Promise<User | null> {
  if (getFirebaseDb()) {
    try {
      return await findUserByIdFirebase(id);
    } catch (err) {
      logger.error({ err }, "Firebase okuma hatası (findUserById), yerel depoya düşülüyor");
    }
  }
  return findUserByIdLocal(id);
}

export async function createUser(username: string, passwordHash: string): Promise<User> {
  if (getFirebaseDb()) {
    // BUL-17: never fall back to local store for writes — throw so the caller
    // handles the error rather than creating a split account in both stores
    return createUserFirebase(username, passwordHash);
  }
  return createUserLocal(username, passwordHash);
}

/**
 * BUL-17: migrate a single pre-existing local user record into Firebase,
 * preserving its original id/createdAt (unlike createUserFirebase, which
 * always mints a fresh id for a brand-new signup).
 *
 * Used exclusively by scripts/migrate-local-to-firebase.ts when an operator
 * switches a deployment from the local JSON store to Firebase after real
 * users have already accumulated locally. Without running this first, those
 * local accounts are invisible to Firebase's usernameIndex and someone else
 * could register the same username as a brand-new (different) account —
 * the account-confusion risk this migration tooling exists to close.
 *
 * Uses the same atomic transaction as createUserFirebase, so concurrent
 * migration runs (or a real signup racing a migration) can never both win.
 */
export type MigrationResult = "migrated" | "already-migrated" | "conflict" | "no-firebase";

export async function migrateUserToFirebase(user: User): Promise<MigrationResult> {
  const db = getFirebaseDb();
  if (!db) return "no-firebase";

  const indexRef = db.ref(`usernameIndex/${usernameIndexKey(user.username)}`);

  // RTDB transactions may re-invoke this callback on contention; capturing
  // the last-seen value here is fine since we only read it once committed.
  let existingOwnerId: string | null = null;
  const txResult = await indexRef.transaction((current) => {
    if (current !== null) {
      existingOwnerId = current as string;
      return undefined; // abort — slot already taken
    }
    return user.id;
  });

  if (!txResult.committed) {
    // Re-running the script is expected (idempotent ops). If the slot is
    // already taken by THIS SAME user's id, that's our own earlier
    // migration, not a real collision with a different identity.
    return existingOwnerId === user.id ? "already-migrated" : "conflict";
  }

  // Migrasyon sırasında limitler yoksa sunucu varsayılanlarını ekle.
  // Bu, eski yerel kullanıcıların Firebase'e geçişinde de tam veri tutarlılığını sağlar.
  const userToWrite: User = user.limits
    ? user
    : {
        ...user,
        limits: {
          storageQuotaBytes: MAX_USER_STORAGE_BYTES,
          maxFileSizeBytes:  MAX_FILE_SIZE,
          chunkSizeBytes:    CHUNK_SIZE,
        },
      };

  try {
    await db.ref(`users/${user.id}`).set(userToWrite);
  } catch (err) {
    await indexRef.remove().catch(() => {});
    throw err;
  }

  return "migrated";
}

export async function usernameExists(username: string): Promise<boolean> {
  // BUL-17: when Firebase is configured, query Firebase directly (no local fallback)
  // to prevent duplicate accounts being created across both stores
  if (getFirebaseDb()) {
    return (await findUserByUsernameFirebase(username)) !== null;
  }
  return findUserByUsernameLocal(username) !== null;
}

// ---------------------------------------------------------------------------
// Per-user limit management
// ---------------------------------------------------------------------------

function resolveDefaults(limits?: UserLimits): ResolvedLimits {
  return {
    storageQuotaBytes: limits?.storageQuotaBytes ?? MAX_USER_STORAGE_BYTES,
    maxFileSizeBytes:  limits?.maxFileSizeBytes  ?? MAX_FILE_SIZE,
    chunkSizeBytes:    limits?.chunkSizeBytes    ?? CHUNK_SIZE,
  };
}

// Local: update the limits field of a user in _users.json
function setLimitsLocal(userId: string, limits: UserLimits): void {
  const p = getUsersFilePath();
  const users = loadLocalUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return;
  users[idx] = { ...users[idx]!, limits };
  fs.writeFileSync(p, JSON.stringify(users, null, 2));
}

// Firebase: update only the limits sub-key to avoid overwriting other fields
async function setLimitsFirebase(userId: string, limits: UserLimits): Promise<void> {
  const db = getFirebaseDb();
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  await db.ref(`users/${userId}/limits`).set(limits);
}

// Local: list all users without passwordHash
function listAllUsersPublicLocal(): PublicUser[] {
  return loadLocalUsers().map(({ passwordHash: _, ...rest }) => rest);
}

// Firebase: list all users without passwordHash
async function listAllUsersPublicFirebase(): Promise<PublicUser[]> {
  const db = getFirebaseDb();
  if (!db) return [];
  const snap = await db.ref("users").get();
  if (!snap.exists()) return [];
  const users: PublicUser[] = [];
  snap.forEach((child) => {
    const u = child.val() as User;
    const { passwordHash: _, ...rest } = u;
    users.push(rest);
  });
  return users;
}

/**
 * Returns the resolved (effective) limits for a user, merging any per-user
 * overrides stored in the database with the server-wide defaults.
 */
export async function getUserLimits(userId: string): Promise<ResolvedLimits> {
  const user = await findUserById(userId);
  return resolveDefaults(user?.limits);
}

/**
 * Persists per-user limit overrides. Pass undefined for any field to clear
 * that override (the field will be omitted and the server default applies).
 * Admin-only — the caller MUST have already verified admin access.
 */
export async function setUserLimits(userId: string, limits: UserLimits): Promise<void> {
  // Strip undefined/null values so they don't persist as explicit nulls
  const cleaned: UserLimits = {};
  if (limits.storageQuotaBytes !== undefined && limits.storageQuotaBytes !== null)
    cleaned.storageQuotaBytes = limits.storageQuotaBytes;
  if (limits.maxFileSizeBytes !== undefined && limits.maxFileSizeBytes !== null)
    cleaned.maxFileSizeBytes = limits.maxFileSizeBytes;
  if (limits.chunkSizeBytes !== undefined && limits.chunkSizeBytes !== null)
    cleaned.chunkSizeBytes = limits.chunkSizeBytes;

  if (getFirebaseDb()) {
    try {
      await setLimitsFirebase(userId, cleaned);
      return;
    } catch (err) {
      logger.error({ err }, "Firebase setLimits error, falling back to local");
    }
  }
  setLimitsLocal(userId, cleaned);
}

/**
 * Removes all per-user limit overrides; the user reverts to server defaults.
 * Admin-only — the caller MUST have already verified admin access.
 */
export async function resetUserLimits(userId: string): Promise<void> {
  if (getFirebaseDb()) {
    try {
      const db = getFirebaseDb()!;
      await db.ref(`users/${userId}/limits`).remove();
      return;
    } catch (err) {
      logger.error({ err }, "Firebase resetLimits error, falling back to local");
    }
  }
  setLimitsLocal(userId, {});
}

// ---------------------------------------------------------------------------
// Son Giriş Zamanı Güncelleme
// ---------------------------------------------------------------------------

/**
 * Başarılı girişten sonra kullanıcının lastLoginAt alanını günceller.
 * Hata durumunda sessizce devam eder — kritik değil, loglama yeterli.
 */
export async function updateLastLogin(userId: string): Promise<void> {
  const now = new Date().toISOString();

  if (getFirebaseDb()) {
    try {
      const db = getFirebaseDb()!;
      await db.ref(`users/${userId}/lastLoginAt`).set(now);
      return;
    } catch (err) {
      logger.error({ err, userId }, "Firebase updateLastLogin error, falling back to local");
    }
  }

  // Yerel fallback
  try {
    const p = getUsersFilePath();
    const users = loadLocalUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx !== -1) {
      users[idx] = { ...users[idx]!, lastLoginAt: now };
      saveLocalUsers(users);
    }
  } catch (err) {
    logger.error({ err, userId }, "Local updateLastLogin error");
  }
}

/**
 * Returns all users without their passwordHash — used by admin endpoints only.
 */
export async function listAllUsersPublic(): Promise<PublicUser[]> {
  if (getFirebaseDb()) {
    try {
      return await listAllUsersPublicFirebase();
    } catch (err) {
      logger.error({ err }, "Firebase listAllUsers error, falling back to local");
    }
  }
  return listAllUsersPublicLocal();
}
