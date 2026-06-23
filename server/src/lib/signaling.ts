import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger.js";
import { sessionMiddleware } from "./sessionMiddleware.js";

const MAX_CONN_PER_IP = 10;
const MAX_MSG_BYTES   = 64 * 1024;
const MAX_MSG_PER_MIN = 120;
const MSG_WINDOW_MS   = 60_000;

interface Client {
  id: string;
  ws: WebSocket;
  userId?: string;
  msgCount: number;
  msgWindowStart: number;
}

const clients     = new Map<string, Client>();
const ipConnCount = new Map<string, number>();

function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function attachSignalingServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const connCount = ipConnCount.get(ip) ?? 0;
    if (connCount >= MAX_CONN_PER_IP) {
      logger.warn({ ip }, "WS connection rejected: too many connections from IP");
      ws.close(1008, "Too many connections from this IP");
      return;
    }
    ipConnCount.set(ip, connCount + 1);

    const clientId = uuidv4();

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
      // session read failure is non-fatal
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
      if (raw.length > MAX_MSG_BYTES) {
        logger.warn({ clientId, bytes: raw.length }, "WS message rejected: too large");
        ws.close(1009, "Message too large");
        return;
      }

      const now = Date.now();
      if (now - client.msgWindowStart >= MSG_WINDOW_MS) {
        client.msgWindowStart = now;
        client.msgCount = 0;
      }
      client.msgCount++;
      if (client.msgCount > MAX_MSG_PER_MIN) {
        send(ws, { type: "error", message: "Rate limit aşıldı." });
        return;
      }
    });

    ws.on("close", () => {
      clients.delete(clientId);
      const count = ipConnCount.get(ip) ?? 1;
      if (count <= 1) ipConnCount.delete(ip);
      else ipConnCount.set(ip, count - 1);
    });
  });

  logger.info("WebSocket server attached at /ws");
}
