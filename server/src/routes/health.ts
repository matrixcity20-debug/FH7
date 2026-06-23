import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Cloudflare TURN credential cache ─────────────────────────────────────────
// Cloudflare issues time-limited credentials (default TTL = 86400s / 24h).
// We cache them server-side and refresh 1 hour before they expire so every
// WebRTC peer gets valid credentials without hitting the Cloudflare API on
// every connection request.

// Cloudflare returns an array of ICE server objects from generate-ice-servers
interface CloudflareTurnResponse {
  iceServers: Array<{
    urls: string[];
    username?: string;
    credential?: string;
  }>;
}

interface CachedCreds {
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  expiresAt: number; // Unix ms
}

let cfCredsCache: CachedCreds | null = null;

async function fetchCloudflareTurnCreds(): Promise<CachedCreds | null> {
  const appId = process.env["CLOUDFLARE_TURN_APP_ID"];
  const token = process.env["CLOUDFLARE_TURN_TOKEN"];
  if (!appId || !token) return null;

  const ttl = 86_400; // 24 hours
  try {
    // Endpoint: generate-ice-servers (returns full iceServers array)
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${appId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as CloudflareTurnResponse;
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) return null;
    return {
      iceServers: data.iceServers,
      // Refresh 1 hour before expiry so credentials are always valid
      expiresAt: Date.now() + (ttl - 3_600) * 1_000,
    };
  } catch {
    return null;
  }
}

async function getCloudflareTurnServers(): Promise<object[] | null> {
  if (!cfCredsCache || Date.now() >= cfCredsCache.expiresAt) {
    cfCredsCache = await fetchCloudflareTurnCreds();
  }
  return cfCredsCache ? cfCredsCache.iceServers : null;
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const iceServersLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek. Lütfen bekleyin." },
});

/**
 * GET /api/ice-servers
 *
 * Priority 1 — Cloudflare TURN (automatic 24-hour credential rotation):
 *   CLOUDFLARE_TURN_APP_ID  — TURN App/Key ID from Cloudflare dashboard
 *   CLOUDFLARE_TURN_TOKEN   — API token with Realtime:Write permission
 *
 * Priority 2 — Custom static TURN (manual credentials):
 *   TURN_URLS       — comma-separated TURN URLs
 *   TURN_USERNAME   — TURN username
 *   TURN_CREDENTIAL — TURN credential/password
 *
 * Fallback — Google STUN only (direct P2P, same-network only)
 */
router.get("/ice-servers", iceServersLimiter, async (_req, res): Promise<void> => {
  const iceServers: object[] = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun.cloudflare.com:3478",
      ],
    },
  ];

  // Priority 1: Cloudflare TURN with auto-rotating credentials
  const cfServers = await getCloudflareTurnServers();
  if (cfServers && cfServers.length > 0) {
    iceServers.push(...cfServers);
  } else {
    // Priority 2: static TURN credentials from env
    const turnUrls = process.env["TURN_URLS"];
    const turnUsername = process.env["TURN_USERNAME"];
    const turnCredential = process.env["TURN_CREDENTIAL"];
    if (turnUrls && turnUsername && turnCredential) {
      iceServers.push({
        urls: turnUrls.split(",").map((u) => u.trim()),
        username: turnUsername,
        credential: turnCredential,
      });
    }
  }

  res.json({ iceServers });
});

export default router;
