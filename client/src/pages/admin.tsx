import { useState, useEffect } from "react";
import {
  Users, Settings, RefreshCw, CheckCircle, AlertCircle,
  RotateCcw, ChevronDown, ChevronUp, Database, UploadCloud, Layers,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

function formatBytes(bytes: number, decimals = 1): string {
  if (!+bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

function bytesFromMB(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

interface ResolvedLimits {
  storageQuotaBytes: number;
  maxFileSizeBytes: number;
  chunkSizeBytes: number;
}

interface AdminUser {
  id: string;
  username: string;
  createdAt: string;
  usedBytes: number;
  limits: ResolvedLimits;
  customLimits: {
    storageQuotaBytes?: number;
    maxFileSizeBytes?: number;
    chunkSizeBytes?: number;
  } | null;
}

interface ServerDefaults {
  storageQuotaBytes: number;
  maxFileSizeBytes: number;
  chunkSizeBytes: number;
}

interface EditState {
  storageQuotaMB: string;
  maxFileSizeMB: string;
}

function StorageBar({ used, total }: { used: number; total: number }) {
  const pct = Math.min(100, (used / Math.max(1, total)) * 100);
  const color = pct >= 95 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
        <span>{formatBytes(used)}</span>
        <span>{formatBytes(total)}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function UserRow({
  user,
  defaults,
  onSave,
  onReset,
}: {
  user: AdminUser;
  defaults: ServerDefaults;
  onSave: (userId: string, limits: { storageQuotaBytes?: number; maxFileSizeBytes?: number }) => Promise<void>;
  onReset: (userId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [edit, setEdit] = useState<EditState>({
    storageQuotaMB: String(Math.round(user.limits.storageQuotaBytes / 1024 / 1024)),
    maxFileSizeMB: String(Math.round(user.limits.maxFileSizeBytes / 1024 / 1024)),
  });

  const hasCustom = user.customLimits !== null && Object.keys(user.customLimits).length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const storageQ = Number(edit.storageQuotaMB);
      const maxFile = Number(edit.maxFileSizeMB);
      if (!Number.isFinite(storageQ) || storageQ < 1) {
        toast({ variant: "destructive", title: "Geçersiz depolama limiti" });
        return;
      }
      if (!Number.isFinite(maxFile) || maxFile < 1) {
        toast({ variant: "destructive", title: "Geçersiz dosya boyutu limiti" });
        return;
      }
      if (maxFile > storageQ) {
        toast({ variant: "destructive", title: "Dosya boyutu limiti, depolama limitini aşamaz" });
        return;
      }
      await onSave(user.id, {
        storageQuotaBytes: bytesFromMB(storageQ),
        maxFileSizeBytes: bytesFromMB(maxFile),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await onReset(user.id);
      setEdit({
        storageQuotaMB: String(Math.round(defaults.storageQuotaBytes / 1024 / 1024)),
        maxFileSizeMB: String(Math.round(defaults.maxFileSizeBytes / 1024 / 1024)),
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
      <button
        className="w-full flex items-center justify-between p-4 hover:bg-muted/20 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-mono font-bold text-primary">{user.username[0]?.toUpperCase()}</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-mono font-semibold text-foreground">{user.username}</p>
              {hasCustom && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/5 text-primary shrink-0">
                  özel limit
                </span>
              )}
            </div>
            <div className="mt-1 w-48">
              <StorageBar used={user.usedBytes} total={user.limits.storageQuotaBytes} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0 ml-4">
          <div className="text-right hidden sm:block">
            <p className="text-[10px] font-mono text-muted-foreground">Maks Dosya</p>
            <p className="text-xs font-mono font-semibold text-foreground">{formatBytes(user.limits.maxFileSizeBytes)}</p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-[10px] font-mono text-muted-foreground">Kota</p>
            <p className="text-xs font-mono font-semibold text-foreground">{formatBytes(user.limits.storageQuotaBytes)}</p>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/40 p-4 space-y-4 bg-muted/5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
                <Database className="w-3 h-3" /> Depolama Kotası (MB)
              </label>
              <input
                type="number"
                min={1}
                value={edit.storageQuotaMB}
                onChange={(e) => setEdit((prev) => ({ ...prev, storageQuotaMB: e.target.value }))}
                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary/40 transition-colors"
                placeholder={String(Math.round(defaults.storageQuotaBytes / 1024 / 1024))}
              />
              <p className="text-[10px] text-muted-foreground font-mono">
                Varsayılan: {formatBytes(defaults.storageQuotaBytes)}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
                <UploadCloud className="w-3 h-3" /> Maks. Dosya Boyutu (MB)
              </label>
              <input
                type="number"
                min={1}
                value={edit.maxFileSizeMB}
                onChange={(e) => setEdit((prev) => ({ ...prev, maxFileSizeMB: e.target.value }))}
                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary/40 transition-colors"
                placeholder={String(Math.round(defaults.maxFileSizeBytes / 1024 / 1024))}
              />
              <p className="text-[10px] text-muted-foreground font-mono">
                Varsayılan: {formatBytes(defaults.maxFileSizeBytes)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 justify-end pt-1">
            {hasCustom && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs font-mono text-muted-foreground gap-1.5"
                disabled={resetting}
                onClick={handleReset}
              >
                <RotateCcw className="w-3 h-3" />
                {resetting ? "Sıfırlanıyor…" : "Varsayılana Dön"}
              </Button>
            )}
            <Button
              size="sm"
              className="text-xs font-mono gap-1.5"
              disabled={saving}
              onClick={handleSave}
            >
              <CheckCircle className="w-3 h-3" />
              {saving ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [defaults, setDefaults] = useState<ServerDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const [usersRes, defaultsRes] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/defaults", { credentials: "include" }),
      ]);
      if (usersRes.ok) setUsers(await usersRes.json() as AdminUser[]);
      if (defaultsRes.ok) setDefaults(await defaultsRes.json() as ServerDefaults);
    } catch {
      toast({ variant: "destructive", title: "Veriler yüklenemedi" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const handleSave = async (userId: string, limits: { storageQuotaBytes?: number; maxFileSizeBytes?: number }) => {
    const res = await fetch(`/api/admin/users/${userId}/limits`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(limits),
    });
    if (!res.ok) {
      const err = await res.json() as { error?: string };
      toast({ variant: "destructive", title: err.error ?? "Kayıt başarısız" });
      return;
    }
    toast({ title: "Limitler güncellendi ✓" });
    await loadData(true);
  };

  const handleReset = async (userId: string) => {
    const res = await fetch(`/api/admin/users/${userId}/limits`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      toast({ variant: "destructive", title: "Sıfırlama başarısız" });
      return;
    }
    toast({ title: "Limitler varsayılana döndürüldü" });
    await loadData(true);
  };

  if (!user?.isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <div className="w-12 h-12 rounded-full bg-destructive/10 border border-destructive/30 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-destructive" />
        </div>
        <p className="text-sm font-mono text-muted-foreground">Bu sayfaya erişim yetkiniz yok.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Shield className="w-3.5 h-3.5 text-primary" />
            </div>
            <h1 className="text-2xl font-bold font-mono gradient-text">Yönetici Paneli</h1>
          </div>
          <p className="text-muted-foreground text-sm">Kullanıcı depolama ve limit yönetimi</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-xs font-mono"
          disabled={refreshing}
          onClick={() => loadData(true)}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Yenile
        </Button>
      </div>

      {defaults && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: Database, label: "Varsayılan Kota", value: formatBytes(defaults.storageQuotaBytes) },
            { icon: UploadCloud, label: "Varsayılan Maks. Dosya", value: formatBytes(defaults.maxFileSizeBytes) },
            { icon: Layers, label: "Parça Boyutu", value: formatBytes(defaults.chunkSizeBytes) },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="p-3 rounded-xl border border-border/60 bg-card/60 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-muted/50 border border-border flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-[10px] font-mono text-muted-foreground">{label}</p>
                <p className="text-sm font-mono font-semibold text-foreground">{value}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
        <Users className="w-3.5 h-3.5" />
        <span>{users.length} kullanıcı</span>
        <Settings className="w-3.5 h-3.5 ml-2" />
        <span>Limitleri değiştirmek için kullanıcıya tıklayın</span>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl border border-border bg-card/60 animate-pulse" />
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border/40 rounded-xl">
          <Users className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground font-mono">Henüz kayıtlı kullanıcı yok</p>
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              defaults={defaults ?? { storageQuotaBytes: 5368709120, maxFileSizeBytes: 524288000, chunkSizeBytes: 1048576 }}
              onSave={handleSave}
              onReset={handleReset}
            />
          ))}
        </div>
      )}
    </div>
  );
}
