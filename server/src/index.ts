import "./lib/env.js";
import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { purgeExpiredFiles, purgeStaleUploadDirs } from "./lib/fileStore.js";
import { purgeStaleUploadSessions } from "./lib/uploadSessionStore.js";
import { attachSignalingServer } from "./lib/signaling.js";
import { restoreMetaFilesFromFirebase } from "./lib/fileRegistry.js";
import { storageHealthMonitor } from "./lib/storageHealthMonitor.js";

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

// ── R2/Firebase: Deploy sonrası meta.json dosyalarını geri yükle ───────────
// uploads/ klasörü deploy'da silinmiş olabilir; Firebase'deki kayıtlardan
// eksik meta.json'ları yeniden oluşturuyoruz. Chunk'lar on-demand R2'den gelir.
restoreMetaFilesFromFirebase()
  .then((count) => {
    if (count > 0) logger.info({ count }, "Restored meta files from Firebase on startup");
  })
  .catch((err) => {
    logger.error({ err }, "Failed to restore meta files from Firebase on startup");
  });

// purgeStaleUploadSessions cleans the in-memory Map; purgeStaleUploadDirs
// cleans any orphan upload_ directories left on disk from a previous server
// process (whose in-memory Map was lost on restart).
const staleSessions = purgeStaleUploadSessions();
if (staleSessions > 0) logger.info({ staleSessions }, "Purged stale upload sessions on startup");
const staleDirs = purgeStaleUploadDirs();
if (staleDirs > 0) logger.info({ staleDirs }, "Purged stale upload dirs on startup");

// ── Depolama sağlık izleyici ───────────────────────────────────────────────
// Yapılandırılmış tüm provider'ları periyodik olarak test eder.
// Interval: HEALTH_CHECK_INTERVAL_MS env (varsayılan: 5 dakika, min: 30 saniye).
storageHealthMonitor.start();

// Graceful shutdown: SIGTERM/SIGINT alındığında izleyiciyi durdur
process.once("SIGTERM", () => storageHealthMonitor.stop());
process.once("SIGINT", () => storageHealthMonitor.stop());

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
