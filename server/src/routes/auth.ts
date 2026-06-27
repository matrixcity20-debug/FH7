import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  findUserByUsername,
  createUser,
  usernameExists,
  findUserById,
  updateLastLogin,
} from "../lib/userStore.js";
import {
  saveEd25519PublicKey,
  getEd25519PublicKey,
  verifyEd25519Signature,
} from "../lib/keyStore.js";
import { getServerECDHPublicKey } from "../lib/ecdhProvider.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    unlockedFiles?: string[];
  }
}

const router: IRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla deneme yapıldı. 15 dakika sonra tekrar deneyin." },
  skipSuccessfulRequests: true,
});

// ── Challenge store (in-memory, 5-minute TTL, one per user) ──────────────────

interface PendingChallenge {
  nonceHex: string;
  expiresAt: number;
}

const _challenges = new Map<string, PendingChallenge>(); // userId → challenge

function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [uid, c] of _challenges) {
    if (c.expiresAt <= now) _challenges.delete(uid);
  }
}

// Prune every 60 seconds to prevent unbounded growth
setInterval(pruneExpiredChallenges, 60_000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkIsAdmin(userId: string): boolean {
  const raw = process.env["ADMIN_USER_IDS"] ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(userId);
}

// ── Registration ──────────────────────────────────────────────────────────────

router.post("/auth/register", authLimiter, async (req, res): Promise<void> => {
  const { username, password, ed25519PubKeyHex } = req.body as {
    username?: string;
    password?: string;
    ed25519PubKeyHex?: string;
  };

  if (!username || typeof username !== "string" || username.trim().length < 3) {
    res.status(400).json({ error: "Kullanıcı adı en az 3 karakter olmalıdır" });
    return;
  }
  if (username.trim().length > 32) {
    res.status(400).json({ error: "Kullanıcı adı en fazla 32 karakter olabilir" });
    return;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
    res.status(400).json({ error: "Kullanıcı adı sadece harf, rakam ve _ - . içerebilir" });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "Şifre en az 6 karakter olmalıdır" });
    return;
  }

  const trimmedUsername = username.trim();

  if (await usernameExists(trimmedUsername)) {
    await bcrypt.hash(password, 12);
    res.status(201).json({ message: "Kayıt tamamlandı. Giriş yapmayı deneyin." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await createUser(trimmedUsername, passwordHash);

    // Register Ed25519 public key if provided by the client
    if (
      ed25519PubKeyHex &&
      typeof ed25519PubKeyHex === "string" &&
      /^[0-9a-f]{64}$/i.test(ed25519PubKeyHex)
    ) {
      await saveEd25519PublicKey(user.id, ed25519PubKeyHex);
      req.log.info({ userId: user.id }, "Ed25519 public key registered at signup");
    }

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = user.id;

    req.log.info({ userId: user.id, username: user.username, hasCryptoKey: !!ed25519PubKeyHex }, "User registered");
    res.status(201).json({ id: user.id, username: user.username });
  } catch (err) {
    if (err instanceof Error && err.message === "USERNAME_TAKEN") {
      res.status(201).json({ message: "Kayıt tamamlandı. Giriş yapmayı deneyin." });
      return;
    }
    req.log.error({ err }, "Register failed");
    res.status(500).json({ error: "Kayıt başarısız, lütfen tekrar deneyin" });
  }
});

// ── Password login (bcrypt fallback / legacy) ─────────────────────────────────

router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    res.status(400).json({ error: "Kullanıcı adı ve şifre gereklidir" });
    return;
  }

  const user = await findUserByUsername(username.trim());
  if (!user) {
    await bcrypt.compare(password, "$2b$12$invalidhashpaddinginvalidhashpaddinginvalidhashpaddingXX");
    res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.userId = user.id;

  updateLastLogin(user.id).catch(() => {});

  req.log.info({ userId: user.id, method: "bcrypt" }, "User logged in");
  res.json({ id: user.id, username: user.username, isAdmin: checkIsAdmin(user.id) });
});

// ── Ed25519 challenge-response — Step 1: issue challenge ─────────────────────

/**
 * POST /auth/challenge
 * Body: { username: string }
 *
 * Returns a 32-byte hex nonce bound to the requesting user.
 * The client must sign this nonce with its Ed25519 private key within 5 minutes
 * and submit it to POST /auth/verify.
 */
router.post("/auth/challenge", authLimiter, async (req, res): Promise<void> => {
  const { username } = req.body as { username?: string };

  if (!username || typeof username !== "string") {
    res.status(400).json({ error: "Kullanıcı adı gereklidir" });
    return;
  }

  const user = await findUserByUsername(username.trim());
  if (!user) {
    // Constant-time response to prevent username enumeration
    await new Promise<void>((r) => setTimeout(r, 50));
    res.status(200).json({ challenge: crypto.randomBytes(32).toString("hex") });
    return;
  }

  const hasKey = await getEd25519PublicKey(user.id);
  if (!hasKey) {
    res.status(404).json({ error: "Bu kullanıcı için kriptografik anahtar bulunamadı" });
    return;
  }

  pruneExpiredChallenges();
  const nonceHex = crypto.randomBytes(32).toString("hex");
  _challenges.set(user.id, { nonceHex, expiresAt: Date.now() + 5 * 60 * 1000 });

  req.log.info({ userId: user.id }, "Ed25519 challenge issued");
  res.json({ challenge: nonceHex });
});

// ── Ed25519 challenge-response — Step 2: verify signature ────────────────────

/**
 * POST /auth/verify
 * Body: { username: string, challenge: string (hex), signature: string (hex) }
 *
 * Verifies the Ed25519 signature of the challenge nonce with the user's stored public key.
 * Creates a session if valid.
 */
router.post("/auth/verify", authLimiter, async (req, res): Promise<void> => {
  const { username, challenge, signature } = req.body as {
    username?: string;
    challenge?: string;
    signature?: string;
  };

  if (
    !username || typeof username !== "string" ||
    !challenge || typeof challenge !== "string" ||
    !signature || typeof signature !== "string"
  ) {
    res.status(400).json({ error: "Eksik alanlar: username, challenge, signature gereklidir" });
    return;
  }

  if (!/^[0-9a-f]{64}$/i.test(challenge)) {
    res.status(400).json({ error: "Geçersiz challenge formatı" });
    return;
  }
  if (!/^[0-9a-f]{128}$/i.test(signature)) {
    res.status(400).json({ error: "Geçersiz imza formatı" });
    return;
  }

  const user = await findUserByUsername(username.trim());
  if (!user) {
    res.status(401).json({ error: "Kimlik doğrulama başarısız" });
    return;
  }

  // Check pending challenge
  const pending = _challenges.get(user.id);
  if (!pending || pending.expiresAt <= Date.now() || pending.nonceHex !== challenge) {
    res.status(401).json({ error: "Challenge geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın." });
    return;
  }

  // Consume the challenge (one-time use)
  _challenges.delete(user.id);

  const messageBytes = Buffer.from(challenge, "hex");
  const isValid = await verifyEd25519Signature(user.id, messageBytes, signature);

  if (!isValid) {
    req.log.warn({ userId: user.id }, "Ed25519 signature verification failed");
    res.status(401).json({ error: "İmza doğrulaması başarısız" });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.userId = user.id;

  updateLastLogin(user.id).catch(() => {});

  req.log.info({ userId: user.id, method: "ed25519" }, "User logged in via Ed25519 challenge-response");
  res.json({ id: user.id, username: user.username, isAdmin: checkIsAdmin(user.id) });
});

// ── Register / update Ed25519 public key (authenticated) ─────────────────────

/**
 * POST /auth/register-key
 * Body: { ed25519PubKeyHex: string }
 * Requires: active session
 *
 * Registers or replaces the Ed25519 verification public key for the authenticated user.
 */
router.post("/auth/register-key", async (req, res): Promise<void> => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Giriş yapmanız gerekiyor" });
    return;
  }

  const { ed25519PubKeyHex } = req.body as { ed25519PubKeyHex?: string };

  if (!ed25519PubKeyHex || typeof ed25519PubKeyHex !== "string") {
    res.status(400).json({ error: "ed25519PubKeyHex gereklidir" });
    return;
  }
  if (!/^[0-9a-f]{64}$/i.test(ed25519PubKeyHex)) {
    res.status(400).json({ error: "Geçersiz Ed25519 public key (64 hex karakter gereklidir)" });
    return;
  }

  try {
    await saveEd25519PublicKey(userId, ed25519PubKeyHex);
    req.log.info({ userId }, "Ed25519 public key registered/updated");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, userId }, "Failed to save Ed25519 public key");
    res.status(500).json({ error: "Anahtar kaydedilemedi" });
  }
});

// ── Server ECDH public key (unauthenticated) ──────────────────────────────────

/**
 * GET /auth/server-pubkey
 *
 * Returns the server's static X25519 public key hex (64 chars = 32 bytes).
 * Clients use this to verify ECDH is happening with the real server.
 */
router.get("/auth/server-pubkey", (_req, res): void => {
  res.json({ x25519PubKeyHex: getServerECDHPublicKey() });
});

// ── Logout ────────────────────────────────────────────────────────────────────

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.clearCookie("fs.sid");
    res.json({ ok: true });
  });
});

// ── Session check ─────────────────────────────────────────────────────────────

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const user = await findUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const hasCryptoKey = !!(await getEd25519PublicKey(userId));
  res.json({
    id: user.id,
    username: user.username,
    isAdmin: checkIsAdmin(user.id),
    hasCryptoKey,
  });
});

export default router;
