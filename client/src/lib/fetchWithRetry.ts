/**
 * fetchWithRetry — enterprise-grade fetch wrapper with exponential back-off.
 *
 * Security invariants:
 *   • Only a known-safe set of HTTP statuses triggers a retry.  4xx errors that
 *     indicate a deterministic client mistake (400, 401, 403, 404, 409, 413, 422…)
 *     are returned immediately — retrying them wastes bandwidth and masks bugs.
 *   • AbortError from an AbortController signal is never retried and always
 *     re-thrown so the caller can clean up without showing a spurious error.
 *   • abortRef is polled both before every attempt and during every sleep tick
 *     (100 ms granularity) so user cancellation is honoured promptly even while
 *     the client is waiting between attempts.
 *   • The Retry-After delay is capped at MAX_RETRY_AFTER_MS (60 s) to prevent a
 *     malicious or misconfigured server from freezing the UI indefinitely.
 *   • Full-jitter back-off (delay ∈ [0, min(base·2ⁿ, cap)]) prevents thundering-
 *     herd when multiple uploads are running concurrently.
 */

/** HTTP status codes worth retrying. Everything else is treated as final. */
const RETRYABLE_STATUSES = new Set([
  408, // Request Timeout
  429, // Too Many Requests  — server may include Retry-After
  502, // Bad Gateway        — common on Render/Fly cold-start
  503, // Service Unavailable — server may include Retry-After
  504, // Gateway Timeout
]);

/** Hard ceiling on a server-provided Retry-After value (milliseconds). */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Distinct error type thrown when abortRef fires during a retry sleep.
 * Callers should treat this identically to a DOMException AbortError.
 */
export class FetchAbortedError extends Error {
  constructor(message = "Upload aborted") {
    super(message);
    this.name = "FetchAbortedError";
  }
}

export interface RetryOptions {
  /**
   * Total number of attempts (first try + retries).
   * Default: 4  (= 1 initial + 3 retries)
   */
  maxAttempts?: number;
  /**
   * Base delay in milliseconds for the exponential back-off.
   * Default: 1 000 ms
   */
  baseDelayMs?: number;
  /**
   * Upper bound on the computed back-off delay (Retry-After may still override
   * up to MAX_RETRY_AFTER_MS).
   * Default: 30 000 ms
   */
  maxDelayMs?: number;
  /**
   * Mutable ref whose `.current` is read before every attempt and on every 100 ms
   * tick during sleeps.  Set to `true` to abort at the next check point.
   */
  abortRef?: React.MutableRefObject<boolean>;
  /**
   * Called after each failed attempt, before sleeping.
   *
   * @param attempt   1-based retry number (first failure → attempt 1)
   * @param maxRetries  total retries that will be made (= maxAttempts - 1)
   * @param delayMs   how long the client will wait before the next attempt
   * @param reason    human-readable description of the failure
   */
  onRetry?: (
    attempt: number,
    maxRetries: number,
    delayMs: number,
    reason: string,
  ) => void;
}

/**
 * Full-jitter exponential back-off.
 * delay ∈ [0, min(baseDelayMs · 2^attempt, maxDelayMs)]
 */
function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.floor(Math.random() * cap);
}

/**
 * Resolves after `ms` milliseconds.  Rejects with FetchAbortedError if
 * `abortRef.current` becomes true during the wait (checked every 100 ms).
 */
function sleep(ms: number, abortRef?: React.MutableRefObject<boolean>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const deadline = Date.now() + ms;

    const tick = () => {
      if (abortRef?.current) {
        reject(new FetchAbortedError("Upload aborted during retry delay"));
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { resolve(); return; }
      setTimeout(tick, Math.min(remaining, 100));
    };

    setTimeout(tick, Math.min(ms, 100));
  });
}

/**
 * Returns true for errors that are worth retrying (transient / infrastructure),
 * false for deterministic client or server errors where retrying is wrong.
 */
function isRetryable(res: Response | null, err: unknown): boolean {
  // Network / CORS / DNS — TypeError: Failed to fetch
  if (err instanceof TypeError) return true;
  // Known retryable HTTP status
  if (res !== null && RETRYABLE_STATUSES.has(res.status)) return true;
  return false;
}

/**
 * Fetches `input` with exponential back-off retry on transient errors.
 *
 * The `signal` in `init` (if any) is passed through to every underlying
 * `fetch` call so AbortController cancellation works at the network level.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const {
    maxAttempts = 4,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    abortRef,
    onRetry,
  } = options;

  const maxRetries = maxAttempts - 1;
  let lastErr: unknown = new Error("Bilinmeyen hata");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Honour abort flag before every network call
    if (abortRef?.current) throw new FetchAbortedError();

    let res: Response | null = null;

    try {
      res = await fetch(input, init);

      // Successful response or a non-retryable HTTP error — return to caller.
      // The caller is responsible for checking res.ok and surfacing error bodies.
      if (res.ok || !isRetryable(res, null)) return res;

      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    } catch (err) {
      // AbortController signal fired — do NOT retry; re-throw immediately.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // FetchAbortedError (from abortRef during a sleep) — re-throw.
      if (err instanceof FetchAbortedError) throw err;
      if (!isRetryable(null, err)) throw err;
      lastErr = err;
    }

    // No more retries — break and throw below.
    if (attempt >= maxRetries) break;

    // Compute delay.  Respect Retry-After for 429 / 503.
    let delayMs = backoffMs(attempt, baseDelayMs, maxDelayMs);
    if (res?.status === 429 || res?.status === 503) {
      const header = res.headers.get("Retry-After");
      if (header) {
        const seconds = parseFloat(header);
        if (Number.isFinite(seconds) && seconds > 0) {
          delayMs = Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
        }
      }
    }

    const reason =
      lastErr instanceof Error ? lastErr.message : String(lastErr);
    onRetry?.(attempt + 1, maxRetries, delayMs, reason);

    await sleep(delayMs, abortRef);
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new Error("Bağlantı başarısız oldu");
}
