import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { AuthError, parseRateLimitHeaders } from "@/lib/auth-error";

interface User {
  id: string;
  username: string;
  isAdmin?: boolean;
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

  const login = async (username: string, password: string) => {
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

  const register = async (username: string, password: string) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password }),
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
