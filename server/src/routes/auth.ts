import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { findUserByUsername, createUser, usernameExists, findUserById } from "../lib/userStore.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
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

router.post("/auth/register", authLimiter, async (req, res): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };

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
    res.status(409).json({ error: "Bu kullanıcı adı zaten kullanılıyor" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const user = await createUser(trimmedUsername, passwordHash);

    req.session.userId = user.id;

    req.log.info({ userId: user.id, username: user.username }, "User registered");
    res.status(201).json({ id: user.id, username: user.username });
  } catch (err) {
    if (err instanceof Error && err.message === "USERNAME_TAKEN") {
      res.status(409).json({ error: "Bu kullanıcı adı zaten kullanılıyor" });
      return;
    }
    req.log.error({ err }, "Register failed");
    res.status(500).json({ error: "Kayıt başarısız, lütfen tekrar deneyin" });
  }
});

router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: "Kullanıcı adı ve şifre gereklidir" });
    return;
  }

  const user = await findUserByUsername(username.trim());
  if (!user) {
    res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
    return;
  }

  req.session.userId = user.id;
  req.log.info({ userId: user.id }, "User logged in");
  res.json({ id: user.id, username: user.username });
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.clearCookie("fs.sid");
    res.json({ ok: true });
  });
});

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
  res.json({ id: user.id, username: user.username });
});

export default router;
