import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { uploadsDir, ensureUploadsDir } from "./fileStore.js";
import { getFirebaseDb } from "./firebase.js";
import { logger } from "./logger.js";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

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
  const user: User = {
    id: uuidv4(),
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
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

  const user: User = {
    id,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
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
    return createUserFirebase(username, passwordHash);
  }
  return createUserLocal(username, passwordHash);
}

export async function usernameExists(username: string): Promise<boolean> {
  return (await findUserByUsername(username)) !== null;
}
