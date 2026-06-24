import "./lib/env.js";
import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { purgeExpiredFiles, purgeStaleUploadDirs } from "./lib/fileStore.js";
import { purgeStaleUploadSessions } from "./lib/uploadSessionStore.js";
import { attachSignalingServer } from "./lib/signaling.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
attachSignalingServer(httpServer);

httpServer.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// ── Startup maintenance ────────────────────────────────────────────────────
// Run once on boot so stale state from a previous process doesn't linger.
const purged = purgeExpiredFiles();
if (purged > 0) logger.info({ purged }, "Purged expired files on startup");

// purgeStaleUploadSessions cleans the in-memory Map; purgeStaleUploadDirs
// cleans any orphan upload_ directories left on disk from a previous server
// process (whose in-memory Map was lost on restart).
const staleSessions = purgeStaleUploadSessions();
if (staleSessions > 0) logger.info({ staleSessions }, "Purged stale upload sessions on startup");
const staleDirs = purgeStaleUploadDirs();
if (staleDirs > 0) logger.info({ staleDirs }, "Purged stale upload dirs on startup");

// ── Hourly maintenance sweep ───────────────────────────────────────────────
setInterval(
  () => {
    // Expired file TTLs
    const expiredFiles = purgeExpiredFiles();
    if (expiredFiles > 0) logger.info({ expiredFiles }, "Purged expired files");

    // Abandoned upload sessions (in-memory Map — dual-axis TTL)
    const staleSessions = purgeStaleUploadSessions();
    if (staleSessions > 0) logger.info({ staleSessions }, "Purged stale upload sessions");

    // Orphan upload_ directories (disk — handles post-restart leftovers)
    const staleDirs = purgeStaleUploadDirs();
    if (staleDirs > 0) logger.info({ staleDirs }, "Purged stale upload dirs");
  },
  60 * 60 * 1_000,
);
