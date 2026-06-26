/**
 * uploadSessionStore — in-memory registry for in-progress chunked uploads.
 *
 * Keeping this in its own module (rather than inside the routes file) lets
 * both the Express route handlers AND the scheduled maintenance job in
 * index.ts import it without circular dependencies.
 *
 * Security invariants maintained here:
 *   • Session ownership: every session is bound to the Express sessionID
 *     (req.sessionID) that created it.  Any upload-part or upload-finalize
 *     request whose sessionID does not match is rejected (IDOR fence).
 *   • Per-user concurrency cap (MAX_SESSIONS_PER_USER): prevents a single
 *     authenticated user from pinning arbitrarily many large-file slots in
 *     memory and on disk simultaneously.
 *   • Dual-axis TTL: sessions are considered stale when EITHER:
 *       (a) no part has been received for INACTIVITY_TTL_MS (2 h), OR
 *       (b) the session total age exceeds MAX_AGE_MS (24 h).
 *     The inactivity axis keeps memory tight for abandoned uploads.
 *     The age axis bounds the damage from a malicious slow-trickle client
 *     that sends one byte per second to keep the session alive indefinitely.
 */

import { logger } from "./logger.js";
import { cleanupUpload } from "./fileStore.js";

// ── TTL constants ─────────────────────────────────────────────────────────────

/** Evict a session that has received no part activity for this long. */
export const INACTIVITY_TTL_MS = 2 * 60 * 60 * 1_000; // 2 hours

/**
 * Absolute ceiling on session age regardless of activity.
 * Guards against a slow-trickle keep-alive attack.
 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24 hours

// ── Per-user concurrency cap ──────────────────────────────────────────────────

/**
 * Maximum number of in-progress upload sessions a single authenticated user
 * may hold simultaneously.  Prevents DoS via repeated upload-init calls.
 */
export const MAX_SESSIONS_PER_USER = 5;

// ── Session type ──────────────────────────────────────────────────────────────

export interface UploadSession {
  /** req.sessionID at upload-init time — the IDOR ownership fence. */
  sessionId: string;
  /** Authenticated user who started this upload — used for the per-user cap. */
  userId: string;
  /** Client-declared file size — server-side upper bound for total received bytes. */
  maxBytes: number;
  /** Running total of bytes written to disk across all parts received so far. */
  receivedBytes: number;
  /** Date.now() at upload-init — baseline for the MAX_AGE_MS axis. */
  createdAt: number;
  /**
   * Updated to Date.now() on every successful part write.
   * Baseline for the INACTIVITY_TTL_MS axis — a genuinely slow upload that
   * keeps writing parts won't be evicted by the inactivity timer.
   */
  lastActivityAt: number;
  /** Per-user resolved maxFileSizeBytes — per-part DoS guard. */
  userMaxFileSizeBytes: number;
  /** Per-user resolved chunkSizeBytes — per-part size enforcement. */
  chunkSizeBytes: number;
}

// ── Internal store ────────────────────────────────────────────────────────────

/**
 * Single authoritative Map for in-progress uploads.
 * Intentionally NOT exported — callers use the accessor functions below so
 * the module boundary is clear and the Map cannot be mutated arbitrarily.
 */
const sessions = new Map<string, UploadSession>();

// ── Accessors ─────────────────────────────────────────────────────────────────

export function getSession(uploadId: string): UploadSession | undefined {
  return sessions.get(uploadId);
}

export function setSession(uploadId: string, session: UploadSession): void {
  sessions.set(uploadId, session);
}

export function deleteSession(uploadId: string): void {
  sessions.delete(uploadId);
}

/**
 * Returns the number of active sessions currently owned by `userId`.
 * Called from upload-init to enforce MAX_SESSIONS_PER_USER.
 *
 * O(n) over the total number of active sessions.  Acceptable because:
 *   • The Map is bounded: MAX_SESSIONS_PER_USER × concurrent users.
 *   • It is only called once per upload-init request, not per-part.
 */
export function countUserSessions(userId: string): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.userId === userId) count++;
  }
  return count;
}

// ── Maintenance ───────────────────────────────────────────────────────────────

/**
 * Evicts stale sessions and removes their temporary disk directories.
 *
 * Staleness is determined by the dual-axis TTL described at the top of
 * this module (inactivity OR absolute age).
 *
 * Safe to call on every scheduler tick — O(n) over active sessions.
 * Returns the number of sessions purged.
 */
export function purgeStaleUploadSessions(): number {
  const now = Date.now();
  const inactivityCutoff = now - INACTIVITY_TTL_MS;
  const ageCutoff = now - MAX_AGE_MS;

  let count = 0;
  for (const [uploadId, rec] of sessions) {
    const staleByInactivity = rec.lastActivityAt < inactivityCutoff;
    const staleByAge = rec.createdAt < ageCutoff;

    if (staleByInactivity || staleByAge) {
      sessions.delete(uploadId);
      cleanupUpload(uploadId);
      count++;
      logger.info(
        {
          uploadId,
          userId: rec.userId,
          staleByInactivity,
          staleByAge,
          ageMs: now - rec.createdAt,
          inactivityMs: now - rec.lastActivityAt,
        },
        "Purged stale upload session",
      );
    }
  }

  return count;
}
