/**
 * Ed25519 Public Key Store
 *
 * Stores each user's Ed25519 VERIFICATION public key (hex-encoded raw 32 bytes).
 * Public keys are used to:
 *
 *  1. Verify login challenge-response signatures (no password sent to server)
 *  2. Verify file ownership signatures at upload time (immutable proof of who uploaded)
 *
 * Storage backends (mirrors the dual-backend pattern of userStore.ts):
 *  - Firebase RTDB: /ed25519Keys/{userId} = { pubKeyHex, registeredAt }
 *  - Local JSON fallback: uploads/_ed25519keys.json
 *
 * SECURITY: Only public keys are ever stored here.
 * Private keys NEVER leave the user's browser (stored in IndexedDB, encrypted).
 */

import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { uploadsDir, ensureUploadsDir } from "./fileStore.js";
import { getFirebaseDb } from "./firebase.js";
import { logger } from "./logger.js";

const FB_KEYS_ROOT = "ed25519Keys";

export interface Ed25519KeyRecord {
  /** Raw 32-byte Ed25519 public key, hex-encoded — 64 lowercase hex chars */
  pubKeyHex: string;
  /** ISO 8601 timestamp when the key was first registered */
  registeredAt: string;
}

// ── Local JSON fallback ───────────────────────────────────────────────────────

function getLocalKeyFilePath(): string {
  ensureUploadsDir();
  return path.join(uploadsDir, "_ed25519keys.json");
}

function loadLocalKeys(): Record<string, Ed25519KeyRecord> {
  const p = getLocalKeyFilePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, Ed25519KeyRecord>;
  } catch {
    return {};
  }
}

function saveLocalKeys(keys: Record<string, Ed25519KeyRecord>): void {
  fs.writeFileSync(getLocalKeyFilePath(), JSON.stringify(keys, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Persists the Ed25519 verification public key for a user. Overwrites any existing key. */
export async function saveEd25519PublicKey(
  userId: string,
  pubKeyHex: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(pubKeyHex)) {
    throw new Error(
      `Invalid Ed25519 public key: expected 64 hex chars (32 bytes), got length ${pubKeyHex.length}`,
    );
  }

  const record: Ed25519KeyRecord = {
    pubKeyHex: pubKeyHex.toLowerCase(),
    registeredAt: new Date().toISOString(),
  };

  const db = getFirebaseDb();
  if (db) {
    try {
      await db.ref(`${FB_KEYS_ROOT}/${userId}`).set(record);
      logger.info({ userId }, "Ed25519 public key saved to Firebase");
      return;
    } catch (err) {
      logger.error({ err, userId }, "Firebase Ed25519 key save failed — falling back to local store");
    }
  }

  const keys = loadLocalKeys();
  keys[userId] = record;
  saveLocalKeys(keys);
  logger.info({ userId }, "Ed25519 public key saved to local store");
}

/** Returns the stored Ed25519 verification public key hex for a user, or null if not registered. */
export async function getEd25519PublicKey(userId: string): Promise<string | null> {
  const db = getFirebaseDb();
  if (db) {
    try {
      const snap = await db.ref(`${FB_KEYS_ROOT}/${userId}`).once("value");
      const record = snap.val() as Ed25519KeyRecord | null;
      return record?.pubKeyHex ?? null;
    } catch (err) {
      logger.error({ err, userId }, "Firebase Ed25519 key fetch failed — falling back to local store");
    }
  }

  const keys = loadLocalKeys();
  return keys[userId]?.pubKeyHex ?? null;
}

/** Returns true if the user has an Ed25519 public key registered. */
export async function hasEd25519Key(userId: string): Promise<boolean> {
  return (await getEd25519PublicKey(userId)) !== null;
}

/**
 * Verifies an Ed25519 signature against the stored public key for a user.
 *
 * @param userId   User whose stored public key to verify against
 * @param message  Raw bytes that were signed (e.g., challenge nonce or SHA-256 file hash)
 * @param sigHex   Hex-encoded 64-byte Ed25519 signature (128 hex chars)
 * @returns true if the signature is valid; false if invalid or no key is registered
 */
export async function verifyEd25519Signature(
  userId: string,
  message: Buffer,
  sigHex: string,
): Promise<boolean> {
  const pubKeyHex = await getEd25519PublicKey(userId);
  if (!pubKeyHex) return false;

  if (!/^[0-9a-f]{128}$/i.test(sigHex)) return false;

  try {
    const pubKeyJwk: crypto.JsonWebKey = {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(pubKeyHex, "hex").toString("base64url"),
    };
    const pubKey = crypto.createPublicKey({ key: pubKeyJwk, format: "jwk" });
    return crypto.verify(null, message, pubKey, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
