import session from "express-session";
import FileStore from "session-file-store";
import path from "path";
import { uploadsDir, ensureUploadsDir } from "./fileStore.js";

const SessionFileStore = FileStore(session);

/**
 * Shared session middleware — imported by both app.ts (Express) and
 * signaling.ts (WebSocket) so both use the same store instance and
 * can read session data from the same cookie. (BUL-02)
 */
function buildSessionMiddleware() {
  const sessionSecret = process.env["SESSION_SECRET"];
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET environment variable is required");
  }

  ensureUploadsDir();
  const sessionsDir = path.join(uploadsDir, "_sessions");

  return session({
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
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

export const sessionMiddleware = buildSessionMiddleware();
