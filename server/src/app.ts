import express, { type Express } from "express";
import cors from "cors";
import { sessionMiddleware } from "./lib/sessionMiddleware.js";
import helmet from "helmet";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";


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
        scriptSrc: ["'self'"],  // BUL-06: unsafe-inline removed — Vite prod build uses module scripts only
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

// BUL-02: shared session middleware (also used by WebSocket signaling server)
app.use(sessionMiddleware);

app.use("/api", router);

if (process.env["NODE_ENV"] === "production") {
  const publicDir = path.resolve(process.cwd(), "dist/public");
  app.use(express.static(publicDir));
  app.get("/*splat", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
