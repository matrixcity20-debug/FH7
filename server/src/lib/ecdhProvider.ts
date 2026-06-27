/**
 * Server-Side ECDH Provider — X25519 Static Key Pair + HKDF Key Derivation
 *
 * Architecture:
 *  - Server holds a STATIC X25519 key pair (loaded from SERVER_ECDH_PRIVATE_JWK env var)
 *  - Per upload: client generates an EPHEMERAL X25519 key pair, sends only the public key
 *  - ECDH(server_static_private × client_ephemeral_public) → 32-byte shared secret
 *  - HKDF-SHA256(shared_secret, salt=fileId, info="filesplit-aes-256-gcm") → 256-bit AES key
 *
 * Security guarantees:
 *  - AES-256-GCM encryption key is NEVER stored anywhere — derived on demand
 *  - Only the 32-byte ephemeral public key is stored (useless without server private key)
 *  - Compromise of Firebase or R2/B2 does NOT expose the AES encryption key
 *  - Per-file forward secrecy: every file has its own unique ephemeral client key pair
 *  - Follows the same ECDH+HKDF model used by TLS 1.3 and the Signal Protocol
 *
 * Startup:
 *  - SERVER_ECDH_PRIVATE_JWK set → loads and uses that key (persistent, required for production)
 *  - Not set → generates an ephemeral key, prints it to logs, warns the operator.
 *    Files encrypted this session will be unreadable after restart (dev only).
 *
 * To generate a persistent key: call generateServerECDHKeyJWK() and set the result
 * as the SERVER_ECDH_PRIVATE_JWK environment secret.
 */

import crypto from "node:crypto";
import { logger } from "./logger.js";

const HKDF_HASH = "sha256";
const AES_KEY_BYTES = 32;
const HKDF_INFO = Buffer.from("filesplit-aes-256-gcm", "utf-8");

interface CachedKeyPair {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
}

let _cachedPair: CachedKeyPair | null = null;

function loadServerKeyPair(): CachedKeyPair {
  if (_cachedPair) return _cachedPair;

  const jwkEnv = process.env["SERVER_ECDH_PRIVATE_JWK"];

  if (jwkEnv?.trim()) {
    try {
      const jwk = JSON.parse(
        Buffer.from(jwkEnv.trim(), "base64").toString("utf-8"),
      ) as crypto.JsonWebKey;
      const privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" });
      const publicKey = crypto.createPublicKey(privateKey);
      const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
      const publicKeyHex = Buffer.from(pubJwk.x, "base64url").toString("hex");
      _cachedPair = { privateKey, publicKeyHex };
      logger.info({ publicKeyHex }, "X25519 ECDH server key pair loaded from environment");
      return _cachedPair;
    } catch (err) {
      logger.error({ err }, "Failed to parse SERVER_ECDH_PRIVATE_JWK — generating ephemeral key pair");
    }
  } else {
    logger.warn(
      "SERVER_ECDH_PRIVATE_JWK not set. Generating an ephemeral X25519 key pair for this session. " +
      "IMPORTANT: Files encrypted with this key will be UNREADABLE after server restart. " +
      "Generate a persistent key with generateServerECDHKeyJWK() and set SERVER_ECDH_PRIVATE_JWK.",
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const publicKeyHex = Buffer.from(pubJwk.x, "base64url").toString("hex");
  const privJwk = privateKey.export({ format: "jwk" });
  const jwkBase64 = Buffer.from(JSON.stringify(privJwk), "utf-8").toString("base64");

  logger.warn(
    { SERVER_ECDH_PRIVATE_JWK: jwkBase64 },
    "Ephemeral ECDH key generated. Set the value above as SERVER_ECDH_PRIVATE_JWK to persist it.",
  );

  _cachedPair = { privateKey, publicKeyHex };
  return _cachedPair;
}

/**
 * Returns the server's static X25519 public key as a 64-character hex string (32 raw bytes).
 * Sent to clients so they can confirm the server identity before submitting their ephemeral key.
 */
export function getServerECDHPublicKey(): string {
  return loadServerKeyPair().publicKeyHex;
}

/**
 * Derives a 256-bit AES-256-GCM encryption key for a specific file using:
 *
 *   key = HKDF-SHA256(
 *     ikm  = ECDH(server_static_private, client_ephemeral_public),
 *     salt = UTF-8(fileId),
 *     info = "filesplit-aes-256-gcm",
 *     len  = 32 bytes,
 *   )
 *
 * The fileId salt ensures that even if two files share the same ephemeral key pair
 * (theoretically impossible but guarded anyway), they will have different AES keys.
 *
 * @param clientEphemeralPubHex  Client's ephemeral X25519 public key — 64 hex chars (32 bytes)
 * @param fileId                 File UUID — used as HKDF salt to bind the key to this file only
 */
export function deriveFileEncryptionKey(
  clientEphemeralPubHex: string,
  fileId: string,
): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(clientEphemeralPubHex)) {
    throw new Error(
      `Invalid ephemeral public key: expected 64 hex chars (32 bytes), got length ${clientEphemeralPubHex.length}`,
    );
  }

  const { privateKey } = loadServerKeyPair();

  const clientPubJwk: crypto.JsonWebKey = {
    kty: "OKP",
    crv: "X25519",
    x: Buffer.from(clientEphemeralPubHex, "hex").toString("base64url"),
  };
  const clientPublicKey = crypto.createPublicKey({ key: clientPubJwk, format: "jwk" });

  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey: clientPublicKey });

  const salt = Buffer.from(fileId, "utf-8");
  const keyBytes = crypto.hkdfSync(HKDF_HASH, sharedSecret, salt, HKDF_INFO, AES_KEY_BYTES);

  return Buffer.from(keyBytes);
}

/**
 * Generates a new SERVER_ECDH_PRIVATE_JWK value.
 * Run once in a trusted environment and store the result as an environment secret.
 */
export function generateServerECDHKeyJWK(): string {
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return Buffer.from(JSON.stringify(jwk), "utf-8").toString("base64");
}

// ── Eager initialisation ──────────────────────────────────────────────────────
// Force the key pair to load at module import time (i.e. server startup) rather
// than lazily on the first request.  This guarantees the startup log always
// contains either the "loaded from environment" message or the ephemeral-key
// warning + SERVER_ECDH_PRIVATE_JWK value that the operator must persist.
loadServerKeyPair();
