import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger.js";
import { isValidFileId, readMeta } from "./fileStore.js";

interface Client {
  id: string;
  ws: WebSocket;
  role?: "seeder" | "leecher";
  fileId?: string;
}

const clients = new Map<string, Client>();
const seeders = new Map<string, string>();

function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function attachSignalingServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const clientId = uuidv4();
    const client: Client = { id: clientId, ws };
    clients.set(clientId, client);

    send(ws, { type: "connected", clientId });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg["type"] as string;

      if (type === "seed") {
        const fileId = msg["fileId"] as string;
        // BUL-02: validate fileId format and file existence before registering seeder
        if (!fileId || !isValidFileId(fileId) || !readMeta(fileId)) {
          send(ws, { type: "error", message: "Geçersiz veya bulunamayan dosya" });
          return;
        }
        client.role = "seeder";
        client.fileId = fileId;
        seeders.set(fileId, clientId);
        logger.info({ clientId, fileId }, "Seeder registered");
        send(ws, { type: "seeding", fileId });
      } else if (type === "leech") {
        const fileId = msg["fileId"] as string;
        client.role = "leecher";
        client.fileId = fileId;
        const seederId = seeders.get(fileId);
        if (!seederId) {
          send(ws, { type: "seeder-offline", fileId });
          return;
        }
        const seeder = clients.get(seederId);
        if (!seeder || seeder.ws.readyState !== WebSocket.OPEN) {
          seeders.delete(fileId);
          send(ws, { type: "seeder-offline", fileId });
          return;
        }
        logger.info({ clientId, seederId, fileId }, "Leecher joined");
        send(seeder.ws, { type: "peer-joined", leecherId: clientId });
        send(ws, { type: "seeder-found", seederId });
      } else if (type === "offer") {
        const to = msg["to"] as string;
        const target = clients.get(to);
        // BUL-02: only relay between clients in the same fileId session
        if (target && client.fileId && target.fileId === client.fileId)
          send(target.ws, { type: "offer", from: clientId, sdp: msg["sdp"] });
      } else if (type === "answer") {
        const to = msg["to"] as string;
        const target = clients.get(to);
        if (target && client.fileId && target.fileId === client.fileId)
          send(target.ws, { type: "answer", from: clientId, sdp: msg["sdp"] });
      } else if (type === "ice") {
        const to = msg["to"] as string;
        const target = clients.get(to);
        if (target && client.fileId && target.fileId === client.fileId)
          send(target.ws, { type: "ice", from: clientId, candidate: msg["candidate"] });
      } else if (type === "seeder-status") {
        const fileId = (msg["fileId"] as string) ?? client.fileId;
        const seederId = fileId ? seeders.get(fileId) : undefined;
        const seeder = seederId ? clients.get(seederId) : undefined;
        const online = !!seeder && seeder.ws.readyState === WebSocket.OPEN;
        send(ws, { type: "seeder-status", fileId, online });
      }
    });

    ws.on("close", () => {
      if (client.role === "seeder" && client.fileId) {
        seeders.delete(client.fileId);
        logger.info({ clientId, fileId: client.fileId }, "Seeder disconnected");
      }
      clients.delete(clientId);
    });
  });

  logger.info("WebSocket signaling server attached at /ws");
}
