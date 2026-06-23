import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger.js";
import { isValidFileId, readMeta } from "./fileStore.js";
import { sessionMiddleware } from "./sessionMiddleware.js";

// ── Security constants ────────────────────────────────────────────────────────
const MAX_CONN_PER_IP = 10;        // simultaneous WS connections per IP
const MAX_MSG_BYTES   = 64 * 1024; // 64 KB per inbound message (SDP fits in ~4 KB)
const MAX_MSG_PER_MIN = 120;       // messages per minute per connection
const MSG_WINDOW_MS   = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// Structural validation for WebRTC SDP objects received over the wire.
// Bozuk veya kötü amaçlı SDP hedef tarafta RTCPeerConnection'ı çökertebilir.
function isValidSdpPayload(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["type"] === "string" &&
    ["offer", "answer"].includes(s["type"]) &&
    typeof s["sdp"] === "string" &&
    s["sdp"].length > 0 &&
    s["sdp"].length < 65_536
  );
}

// Structural validation for WebRTC ICE candidate objects.
function isValidCandidatePayload(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return typeof c["candidate"] === "string" && c["candidate"].length < 4_096;
}

interface Client {
  id: string;
  ws: WebSocket;
  role?: "seeder" | "leecher";
  fileId?: string;
  userId?: string;
  // Rate-limit state
  msgCount: number;
  msgWindowStart: number;
}

const clients     = new Map<string, Client>();
const seeders     = new Map<string, string[]>(); // fileId → pool of clientIds
const ipConnCount = new Map<string, number>();   // IP → active connection count

function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function attachSignalingServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    // ── BUG-A fix: per-IP connection limit ────────────────────────────────────
    const ip = req.socket.remoteAddress ?? "unknown";
    const connCount = ipConnCount.get(ip) ?? 0;
    if (connCount >= MAX_CONN_PER_IP) {
      logger.warn({ ip }, "WS connection rejected: too many connections from IP");
      ws.close(1008, "Too many connections from this IP");
      return;
    }
    ipConnCount.set(ip, connCount + 1);

    const clientId = uuidv4();

    // Extract authenticated userId from the session cookie
    let userId: string | undefined;
    try {
      await new Promise<void>((resolve) =>
        sessionMiddleware(
          req as Parameters<typeof sessionMiddleware>[0],
          {} as Parameters<typeof sessionMiddleware>[1],
          () => resolve(),
        )
      );
      userId = (req as Record<string, unknown> & { session?: { userId?: string } })?.session?.userId;
    } catch {
      // session read failure is non-fatal — client just won't be allowed to seed
    }

    const client: Client = {
      id: clientId,
      ws,
      userId,
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    clients.set(clientId, client);
    send(ws, { type: "connected", clientId });

    ws.on("message", (raw) => {
      // ── BUG-B fix: reject oversized messages before JSON.parse ────────────
      if (raw.length > MAX_MSG_BYTES) {
        logger.warn({ clientId, bytes: raw.length }, "WS message rejected: too large");
        ws.close(1009, "Message too large");
        return;
      }

      // ── BUG-A fix: per-connection message rate limit ──────────────────────
      const now = Date.now();
      if (now - client.msgWindowStart >= MSG_WINDOW_MS) {
        client.msgWindowStart = now;
        client.msgCount = 0;
      }
      client.msgCount++;
      if (client.msgCount > MAX_MSG_PER_MIN) {
        send(ws, { type: "error", message: "Rate limit aşıldı — çok hızlı mesaj gönderiyorsunuz." });
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg["type"] as string;

      if (type === "seed") {
        // ── BUG-J fix: prevent second seed registration on same connection ───
        if (client.role === "seeder") {
          send(ws, { type: "error", message: "Bu bağlantı zaten bir dosyayı seed ediyor. Yeni dosya için yeni bağlantı açın." });
          return;
        }

        const fileId = msg["fileId"] as string;
        if (!fileId || !isValidFileId(fileId)) {
          send(ws, { type: "error", message: "Geçersiz dosya kimliği" });
          return;
        }
        const fileMeta = readMeta(fileId);
        if (!fileMeta) {
          send(ws, { type: "error", message: "Dosya bulunamadı" });
          return;
        }
        // Verify the connecting client is the actual file owner
        if (!client.userId || fileMeta.userId !== client.userId) {
          send(ws, { type: "error", message: "Bu dosyanın sahibi değilsiniz" });
          logger.warn({ clientId, fileId, clientUserId: client.userId, fileOwner: fileMeta.userId }, "Unauthorized seed attempt");
          return;
        }
        client.role = "seeder";
        client.fileId = fileId;
        const pool = seeders.get(fileId) ?? [];
        if (!pool.includes(clientId)) pool.push(clientId);
        seeders.set(fileId, pool);
        logger.info({ clientId, fileId, poolSize: pool.length }, "Seeder registered");
        send(ws, { type: "seeding", fileId });

      } else if (type === "leech") {
        const fileId = msg["fileId"] as string;
        // ── BUG-C fix: validate fileId on leech (was missing before) ─────────
        if (!fileId || !isValidFileId(fileId)) {
          send(ws, { type: "error", message: "Geçersiz dosya kimliği" });
          return;
        }
        client.role = "leecher";
        client.fileId = fileId;
        // Pick first live seeder from pool, prune stale entries
        const seederPool = seeders.get(fileId);
        let chosenSeeder: Client | undefined;
        let chosenId: string | undefined;
        if (seederPool) {
          const live = seederPool.filter((sid) => {
            const s = clients.get(sid);
            return s && s.ws.readyState === WebSocket.OPEN;
          });
          if (live.length > 0) {
            seeders.set(fileId, live);
            chosenId = live[0];
            chosenSeeder = clients.get(chosenId);
          } else {
            seeders.delete(fileId);
          }
        }
        if (!chosenSeeder || !chosenId) {
          send(ws, { type: "seeder-offline", fileId });
          return;
        }
        logger.info({ clientId, seederId: chosenId, fileId }, "Leecher joined");
        send(chosenSeeder.ws, { type: "peer-joined", leecherId: clientId });
        send(ws, { type: "seeder-found", seederId: chosenId });

      } else if (type === "offer") {
        // ── BUG-D fix: validate UUID and SDP payload before relay ─────────────
        const to = msg["to"] as string;
        if (!isValidUUID(to)) return;
        if (!isValidSdpPayload(msg["sdp"])) return;
        const target = clients.get(to);
        if (target && client.fileId && target.fileId === client.fileId)
          send(target.ws, { type: "offer", from: clientId, sdp: msg["sdp"] });

      } else if (type === "answer") {
        // ── BUG-D fix: validate UUID and SDP payload before relay ─────────────
        const to = msg["to"] as string;
        if (!isValidUUID(to)) return;
        if (!isValidSdpPayload(msg["sdp"])) return;
        const target = clients.get(to);
        if (target && client.fileId && target.fileId === client.fileId)
          send(target.ws, { type: "answer", from: clientId, sdp: msg["sdp"] });

      } else if (type === "ice") {
        // ── BUG-D fix: validate UUID and ICE candidate payload before relay ───
        const to = msg["to"] as string;
        if (!isValidUUID(to)) return;
        if (!isValidCandidatePayload(msg["candidate"])) return;
        const target = clients.get(to);
        if (target && client.fileId && target.fileId === client.fileId)
          send(target.ws, { type: "ice", from: clientId, candidate: msg["candidate"] });

      } else if (type === "seeder-status") {
        // ── BUG-F fix: validate fileId before status lookup (was info leak) ───
        const rawFileId = msg["fileId"] as string | undefined;
        const fileId =
          rawFileId && isValidFileId(rawFileId) ? rawFileId
          : client.fileId && isValidFileId(client.fileId) ? client.fileId
          : null;
        if (!fileId) {
          send(ws, { type: "seeder-status", fileId: null, online: false });
          return;
        }
        const pool = seeders.get(fileId);
        const online = !!(pool?.some((sid) => {
          const s = clients.get(sid);
          return s && s.ws.readyState === WebSocket.OPEN;
        }));
        send(ws, { type: "seeder-status", fileId, online });
      }
    });

    ws.on("close", () => {
      if (client.role === "seeder" && client.fileId) {
        const pool = seeders.get(client.fileId);
        if (pool) {
          const updated = pool.filter((id) => id !== clientId);
          if (updated.length > 0) seeders.set(client.fileId, updated);
          else seeders.delete(client.fileId);
        }
        logger.info({ clientId, fileId: client.fileId }, "Seeder disconnected");
      }
      clients.delete(clientId);
      // ── BUG-A fix: decrement IP connection count on disconnect ────────────
      const count = ipConnCount.get(ip) ?? 1;
      if (count <= 1) ipConnCount.delete(ip);
      else ipConnCount.set(ip, count - 1);
    });
  });

  logger.info("WebSocket signaling server attached at /ws");
}
