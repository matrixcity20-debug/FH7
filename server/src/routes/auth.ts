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

// ── Rate limiters ─────────────────────────────────────────────────────────────

/**
 * General auth limiter — register & bcrypt login.
 * skipSuccessfulRequests: true so legitimate logins don't eat quota.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla deneme yapıldı. 15 dakika sonra tekrar deneyin." },
  skipSuccessfulRequests: true,
});

/**
 * Challenge issuance limiter.
 * skipSuccessfulRequests: FALSE — every challenge request counts, including
 * successful ones, to prevent an attacker from harvesting challenges
 * indefinitely from multiple accounts.
 */
const challengeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla challenge isteği. 15 dakika sonra tekrar deneyin." },
  skipSuccessfulRequests: false,
});

/**
 * Signature verification limiter.
 * Very strict: every attempt counts regardless of outcome.
 * Per-user lockout (below) provides additional defence against distributed attacks.
 */
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla doğrulama denemesi. 15 dakika sonra tekrar deneyin." },
  skipSuccessfulRequests: false,
});

/**
 * Key-registration limiter (authenticated endpoint).
 * Low limit — legitimate users register a key once and almost never update it.
 */
const registerKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Anahtar kayıt isteği limiti aşıldı. 1 saat sonra tekrar deneyin." },
  skipSuccessfulRequests: false,
});

/**
 * Server public-key endpoint limiter.
 * Generous but bounded to prevent automated scraping.
 */
const pubkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "İstek limiti aşıldı." },
  skipSuccessfulRequests: true,
});

// ── Per-user failed-attempt tracker (Ed25519 verify only) ────────────────────
//
// Defends against distributed (multi-IP) brute-force against a single account.
// IP-only rate limiters are blind to this attack vector.
//
// Policy: 5 consecutive failures within the window → 30-minute account lockout.
// A successful verification always clears the counter.

interface FailedAttemptEntry {
  count: number;
  lockedUntil: number | null;
  lastAttempt: number;
}

const _failedAttempts = new Map<string, FailedAttemptEntry>();
const FA_LIMIT = 5;                        // failures before lockout
const FA_WINDOW_MS = 30 * 60 * 1000;      // sliding window: 30 minutes
const FA_LOCKOUT_MS = 30 * 60 * 1000;     // lockout duration: 30 minutes

function recordFailedVerification(userId: string): void {
  const now = Date.now();
  const entry = _failedAttempts.get(userId) ?? { count: 0, lockedUntil: null, lastAttempt: 0 };

  // Reset counter if last failure was outside the window and we are not locked
  if (entry.lockedUntil === null && now - entry.lastAttempt > FA_WINDOW_MS) {
    entry.count = 0;
  }

  entry.count += 1;
  entry.lastAttempt = now;

  if (entry.count >= FA_LIMIT) {
    entry.lockedUntil = now + FA_LOCKOUT_MS;
  }

  _failedAttempts.set(userId, entry);
}

function isAccountLocked(userId: string): { locked: boolean; remainingMs: number } {
  const entry = _failedAttempts.get(userId);
  if (!entry || entry.lockedUntil === null) return { locked: false, remainingMs: 0 };

  const remaining = entry.lockedUntil - Date.now();
  if (remaining <= 0) {
    _failedAttempts.delete(userId);
    return { locked: false, remainingMs: 0 };
  }

  return { locked: true, remainingMs: remaining };
}

function clearFailedAttempts(userId: string): void {
  _failedAttempts.delete(userId);
}

// Prune stale entries every 10 minutes to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of _failedAttempts) {
    const stale =
      entry.lockedUntil !== null
        ? now >= entry.lockedUntil
        : now - entry.lastAttempt > FA_WINDOW_MS;
    if (stale) _failedAttempts.delete(uid);
  }
}, 10 * 60 * 1000);

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
router.post("/auth/challenge", challengeLimiter, async (req, res): Promise<void> => {
  const { username } = req.body as { username?: string };

  if (!username || typeof username !== "string") {
    res.status(400).json({ error: "Kullanıcı adı gereklidir" });
    return;
  }

  const user = await findUserByUsername(username.trim());
  if (!user) {
    // Constant-time response — prevent username enumeration via timing
    await new Promise<void>((r) => setTimeout(r, 50 + Math.random() * 50));
    res.status(200).json({ challenge: crypto.randomBytes(32).toString("hex") });
    return;
  }

  // Reject challenge issuance if the account is already locked out
  const { locked, remainingMs } = isAccountLocked(user.id);
  if (locked) {
    const remainingMin = Math.ceil(remainingMs / 60_000);
    req.log.warn({ userId: user.id }, "Challenge request rejected: account locked");
    res.status(429).json({
      error: `Hesap geçici olarak kilitlendi. ${remainingMin} dakika sonra tekrar deneyin.`,
    });
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
router.post("/auth/verify", verifyLimiter, async (req, res): Promise<void> => {
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
    // Constant-time response — prevent username enumeration via timing
    await new Promise<void>((r) => setTimeout(r, 50 + Math.random() * 50));
    res.status(401).json({ error: "Kimlik doğrulama başarısız" });
    return;
  }

  // Per-user lockout check — defends against distributed multi-IP attacks
  const lockStatus = isAccountLocked(user.id);
  if (lockStatus.locked) {
    const remainingMin = Math.ceil(lockStatus.remainingMs / 60_000);
    req.log.warn({ userId: user.id }, "Verify request rejected: account locked");
    res.status(429).json({
      error: `Hesap geçici olarak kilitlendi. ${remainingMin} dakika sonra tekrar deneyin.`,
    });
    return;
  }

  // Check pending challenge
  const pending = _challenges.get(user.id);
  if (!pending || pending.expiresAt <= Date.now() || pending.nonceHex !== challenge) {
    recordFailedVerification(user.id);
    res.status(401).json({ error: "Challenge geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın." });
    return;
  }

  // Consume the challenge atomically (one-time use — must happen before verification)
  _challenges.delete(user.id);

  const messageBytes = Buffer.from(challenge, "hex");
  const isValid = await verifyEd25519Signature(user.id, messageBytes, signature);

  if (!isValid) {
    recordFailedVerification(user.id);
    const failEntry = _failedAttempts.get(user.id);
    const remaining = FA_LIMIT - (failEntry?.count ?? FA_LIMIT);
    req.log.warn({ userId: user.id, attemptsRemaining: remaining }, "Ed25519 signature verification failed");
    res.status(401).json({ error: "İmza doğrulaması başarısız" });
    return;
  }

  // Success — clear any accumulated failure counter
  clearFailedAttempts(user.id);

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
router.post("/auth/register-key", registerKeyLimiter, async (req, res): Promise<void> => {
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
router.get("/auth/server-pubkey", pubkeyLimiter, (_req, res): void => {
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
