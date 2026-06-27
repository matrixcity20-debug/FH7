import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { AuthError, parseRateLimitHeaders } from "@/lib/auth-error";
import * as clientCrypto from "@/lib/clientCrypto";

interface User {
  id: string;
  username: string;
  isAdmin?: boolean;
  hasCryptoKey?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data as User | null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Login flow:
   *  1. Check if this browser has a stored Ed25519 key pair for the user.
   *  2. If yes → Ed25519 challenge-response (password used only locally to decrypt private key).
   *  3. If no (or challenge-response fails) → fall back to classic bcrypt login.
   */
  const login = async (username: string, password: string) => {
    // ── Try Ed25519 challenge-response first ──────────────────────────────────
    // We need the user's ID to look up local IndexedDB keys, but we only have
    // the username here. We'll attempt a challenge request; if the server says
    // the user has no key, we fall back to bcrypt login.
    try {
      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      if (challengeRes.ok) {
        const { challenge } = await challengeRes.json() as { challenge: string };

        // Ask the server for the user's ID (via a lightweight pre-check) —
        // we need it to find the IndexedDB record. Instead of a round-trip,
        // we store the key under username in IndexedDB for simplicity.
        const signature = await clientCrypto.unlockAndSignChallenge(username, password, challenge);

        if (signature) {
          const verifyRes = await fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ username, challenge, signature }),
          });

          if (verifyRes.ok) {
            const data = await verifyRes.json() as User;
            setUser(data);
            return;
          }

          // Signature rejected → fall through to bcrypt
        }
        // No local key pair → fall through to bcrypt
      } else if (challengeRes.status !== 404) {
        // 404 = user has no crypto key → expected, fall through
        // Other errors → let bcrypt handle it
      }
    } catch {
      // Network error or crypto failure → fall through to bcrypt
    }

    // ── Classic bcrypt login (fallback / legacy) ──────────────────────────────
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const { remaining, resetAt, isRateLimited } = parseRateLimitHeaders(res);
      const data = await res.json() as { error?: string };
      throw new AuthError(data.error ?? "Giriş başarısız", {
        remaining,
        resetAt,
        isRateLimited,
      });
    }

    const data = await res.json() as User;
    setUser(data);
  };

  /**
   * Registration flow:
   *  1. Generate Ed25519 key pair in browser (private key stays local, encrypted in IndexedDB).
   *  2. Send the Ed25519 public key to the server along with the account credentials.
   *  3. The server stores the bcrypt hash (for legacy compat) AND the Ed25519 public key.
   *  4. Future logins will use Ed25519 challenge-response; password only unlocks local key.
   */
  const register = async (username: string, password: string) => {
    // Generate Ed25519 key pair — store private key in IndexedDB under username
    let ed25519PubKeyHex: string | undefined;
    try {
      const result = await clientCrypto.generateAndStoreKeyPair(username, password);
      ed25519PubKeyHex = result.ed25519PubKeyHex;
    } catch {
      // Key generation failed (e.g., browser doesn't support Ed25519)
      // Proceed with registration without crypto key (bcrypt-only mode)
    }

    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        username,
        password,
        ...(ed25519PubKeyHex ? { ed25519PubKeyHex } : {}),
      }),
    });

    if (!res.ok) {
      const { remaining, resetAt, isRateLimited } = parseRateLimitHeaders(res);
      const data = await res.json() as { error?: string };
      throw new AuthError(data.error ?? "Kayıt başarısız", {
        remaining,
        resetAt,
        isRateLimited,
      });
    }

    const data = await res.json() as User;
    setUser(data);
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    clientCrypto.clearSessionKeys();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
