import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { purgeExpiredFiles } from "./lib/fileStore.js";
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

const purged = purgeExpiredFiles();
if (purged > 0) logger.info({ purged }, "Purged expired files on startup");

setInterval(
  () => {
    const count = purgeExpiredFiles();
    if (count > 0) logger.info({ count }, "Purged expired files");
  },
  60 * 60 * 1000,
);
