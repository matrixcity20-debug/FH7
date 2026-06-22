import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import FileStore from "session-file-store";
import helmet from "helmet";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { uploadsDir, ensureUploadsDir } from "./lib/fileStore.js";

const SessionFileStore = FileStore(session);

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    // BUL-06: enable CSP with permissive policy (supports React, WebRTC, WebSocket)
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "wss:", "ws:", "https:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// BUL-05: fail-fast in production if ALLOWED_ORIGINS is not configured
if (process.env["NODE_ENV"] === "production" && !process.env["ALLOWED_ORIGINS"]) {
  throw new Error("ALLOWED_ORIGINS environment variable is required in production");
}
const allowedOrigins: string[] | true = process.env["ALLOWED_ORIGINS"]
  ? process.env["ALLOWED_ORIGINS"].split(",").map((o) => o.trim())
  : true;

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const sessionSecret = process.env["SESSION_SECRET"];
if (!sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required");
}

ensureUploadsDir();
const sessionsDir = path.join(uploadsDir, "_sessions");

app.use(
  session({
    store: new SessionFileStore({
      path: sessionsDir,
      ttl: 7 * 24 * 60 * 60,
      retries: 1,
      logFn: () => {},
    }),
    name: "fs.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use("/api", router);

if (process.env["NODE_ENV"] === "production") {
  const publicDir = path.resolve(process.cwd(), "dist/public");
  app.use(express.static(publicDir));
  app.get("/*splat", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
