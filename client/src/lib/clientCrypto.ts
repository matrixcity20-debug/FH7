/**
 * Client-Side Cryptographic Module
 *
 * Implements a cryptocurrency-wallet-style identity and encryption system
 * using only the native Web Crypto API (no external dependencies):
 *
 * 1. IDENTITY — Ed25519 (same algorithm as Ethereum 2.0, Solana, modern SSH):
 *    - Key pair generated once on registration, stored encrypted in IndexedDB
 *    - Authentication via challenge-response: server issues a nonce, client signs it
 *    - Private key is AES-256-GCM encrypted with a PBKDF2(password) wrapping key
 *    - Password NEVER sent to the server after the initial registration bcrypt hash
 *
 * 2. FILE OWNERSHIP — Ed25519:
 *    - File SHA-256 hash signed with the user's Ed25519 private key at upload time
 *    - Signature stored in file metadata → immutable, cryptographically verifiable proof
 *    - Compromise of the server database does not forge ownership (only key holder can sign)
 *
 * 3. ENCRYPTION KEY EXCHANGE — X25519 ECDH (same as TLS 1.3 / Signal Protocol):
 *    - Ephemeral X25519 key pair generated fresh for each file upload, never stored
 *    - Only the 32-byte ephemeral PUBLIC key is sent to the server
 *    - Server does ECDH(server_static_private, client_ephemeral_public) + HKDF → AES-256 key
 *    - AES key never persisted; even a complete storage breach cannot decrypt files
 *
 * IndexedDB schema (database: "filesplit-crypto", store: "keypairs"):
 *   { userId, wrappedSigningKey, signingPubKeyHex, pbkdf2Salt, aesGcmIv }
 *   - wrappedSigningKey: Ed25519 private key JWK encrypted with AES-256-GCM
 *   - PBKDF2(password, salt, 300_000 iterations, SHA-256) → wrapping key
 *   - X25519 keys: ephemeral, never stored
 *
 * Browser requirements: Chrome 113+, Firefox 130+, Safari 17+
 */

const DB_NAME = "filesplit-crypto";
const DB_VERSION = 1;
const STORE_NAME = "keypairs";
const PBKDF2_ITERATIONS = 300_000;
const PBKDF2_HASH = "SHA-256";

// In-memory cache of the unlocked signing key for this browser session.
// Cleared automatically on page reload (not stored in sessionStorage).
let _cachedSigningKey: CryptoKey | null = null;
let _cachedUserId: string | null = null;

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface StoredKeyPair {
  userId: string;
  /** AES-256-GCM encrypted Ed25519 private key JWK */
  wrappedSigningKey: ArrayBuffer;
  /** Ed25519 public key, 64 lowercase hex chars (32 raw bytes) */
  signingPubKeyHex: string;
  /** 16-byte PBKDF2 salt */
  pbkdf2Salt: ArrayBuffer;
  /** 12-byte AES-GCM IV used to wrap the signing key */
  aesGcmIv: ArrayBuffer;
}

async function dbGet(userId: string): Promise<StoredKeyPair | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(userId);
    req.onsuccess = () => resolve((req.result as StoredKeyPair | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(entry: StoredKeyPair): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── PBKDF2 key derivation ─────────────────────────────────────────────────────

async function deriveWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const rawPassword = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey("raw", rawPassword, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

// ── Hex helpers ───────────────────────────────────────────────────────────────

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuf(hex: string): Uint8Array {
  const arr = hex.match(/.{2}/g);
  if (!arr) throw new Error("Invalid hex string");
  return new Uint8Array(arr.map((b) => parseInt(b, 16)));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if this browser has an Ed25519 key pair stored for the given userId.
 */
export async function hasLocalKeyPair(userId: string): Promise<boolean> {
  try {
    return (await dbGet(userId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Generates a new Ed25519 key pair and persists it encrypted in IndexedDB.
 * The private key is wrapped with AES-256-GCM using PBKDF2(password, randomSalt).
 * The unlocked private key is cached in memory for the rest of this browser session.
 *
 * @returns The Ed25519 public key as 64 lowercase hex chars — register this with the server
 */
export async function generateAndStoreKeyPair(
  userId: string,
  password: string,
): Promise<{ ed25519PubKeyHex: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );

  const pubKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const ed25519PubKeyHex = bufToHex(pubKeyRaw);

  const pbkdf2Salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveWrappingKey(password, pbkdf2Salt);
  const aesGcmIv = crypto.getRandomValues(new Uint8Array(12));

  const wrappedSigningKey = await crypto.subtle.wrapKey(
    "jwk",
    keyPair.privateKey,
    wrappingKey,
    { name: "AES-GCM", iv: aesGcmIv },
  );

  await dbPut({
    userId,
    wrappedSigningKey,
    signingPubKeyHex: ed25519PubKeyHex,
    pbkdf2Salt: pbkdf2Salt.buffer,
    aesGcmIv: aesGcmIv.buffer,
  });

  _cachedSigningKey = keyPair.privateKey;
  _cachedUserId = userId;

  return { ed25519PubKeyHex };
}

/**
 * Decrypts the stored Ed25519 private key using the user's password,
 * signs the challenge nonce, and caches the key for this session.
 *
 * @param userId        User ID (used as IndexedDB record key)
 * @param password      User's password (used only locally to unwrap the private key)
 * @param challengeHex  64-char hex nonce issued by the server
 * @returns 128-char hex Ed25519 signature, or null if decryption fails (wrong password / no key)
 */
export async function unlockAndSignChallenge(
  userId: string,
  password: string,
  challengeHex: string,
): Promise<string | null> {
  try {
    let signingKey = _cachedUserId === userId ? _cachedSigningKey : null;

    if (!signingKey) {
      const entry = await dbGet(userId);
      if (!entry) return null;

      const pbkdf2Salt = new Uint8Array(entry.pbkdf2Salt);
      const aesGcmIv = new Uint8Array(entry.aesGcmIv);
      const wrappingKey = await deriveWrappingKey(password, pbkdf2Salt);

      signingKey = await crypto.subtle.unwrapKey(
        "jwk",
        entry.wrappedSigningKey,
        wrappingKey,
        { name: "AES-GCM", iv: aesGcmIv },
        { name: "Ed25519" },
        false,
        ["sign"],
      );

      _cachedSigningKey = signingKey;
      _cachedUserId = userId;
    }

    const challengeBytes = hexToBuf(challengeHex);
    const sigBytes = await crypto.subtle.sign("Ed25519", signingKey, challengeBytes);
    return bufToHex(sigBytes);
  } catch {
    return null;
  }
}

/**
 * Signs the SHA-256 hash of a file with the cached Ed25519 private key.
 * Returns null if no key is cached (user has no key pair or used password-only login).
 *
 * @param sha256Hex  SHA-256 hash of the file, 64 hex chars
 * @returns 128-char hex Ed25519 signature, or null
 */
export async function signFileHash(sha256Hex: string): Promise<string | null> {
  if (!_cachedSigningKey) return null;
  try {
    const hashBytes = hexToBuf(sha256Hex);
    const sigBytes = await crypto.subtle.sign("Ed25519", _cachedSigningKey, hashBytes);
    return bufToHex(sigBytes);
  } catch {
    return null;
  }
}

/**
 * Generates a fresh ephemeral X25519 key pair and returns ONLY the public key as hex.
 * The private key is immediately discarded — the server performs ECDH using its static
 * private key and this ephemeral public key to derive the file's AES-256 encryption key.
 *
 * @returns 64-char hex string (32 raw bytes) of the ephemeral X25519 public key
 */
export async function generateEphemeralECDHPublicKey(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveKey", "deriveBits"],
  );
  const pubKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return bufToHex(pubKeyRaw);
}

/**
 * Clears the in-memory signing key cache. Call on logout to ensure the
 * decrypted private key does not linger in memory after the session ends.
 */
export function clearSessionKeys(): void {
  _cachedSigningKey = null;
  _cachedUserId = null;
}
