import { useState, useEffect } from "react";
import {
  Users, Settings, RefreshCw, CheckCircle, AlertCircle,
  RotateCcw, ChevronDown, ChevronUp, Database, UploadCloud, Layers,
  Shield, Flag, Trash2, ExternalLink, XCircle, AlertTriangle, FileText,
  HardDrive, Cloud, CloudOff, Lock, Wifi, WifiOff, BarChart3, ServerCrash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { format, formatDistanceToNow } from "date-fns";
import { tr } from "date-fns/locale";

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
  lastLoginAt: string | null;
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

interface FileReport {
  reportId: string;
  dosyaLinki: string;
  dosyaId: string;
  dosyaAdi: string;
  yukleyenKullanici: string;
  yukleyenKullaniciId: string;
  sikayetNedeni: string;
  sikayetEdenIp: string;
  sikayetEdenKullanici: string;
  tarih: string;
}

// ── Depolama Tipleri ──────────────────────────────────────────────────────────

interface BucketBreakdown {
  fileCount: number;
  totalBytes: number;
  provider: "r2" | "b2" | "unknown";
}

interface StorageFileEntry {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  userId: string | undefined;
  chunkCount: number;
  provider: "r2" | "b2" | "unknown";
  bucket: string;
  encrypted: boolean;
  uploadedAt: string;
  storageUploadedAt: string | undefined;
  expiresAt: string | null;
  cloudStatus: "ready" | "pending" | "failed";
  cloudError?: string;
}

interface StorageStats {
  r2Configured: boolean;
  b2Configured: boolean;
  firebaseConnected: boolean;
  configuredBuckets: string[];
  b2Buckets: string[];
  totals: {
    fileCount: number;
    totalBytes: number;
    encryptedCount: number;
    unencryptedCount: number;
    pendingCount: number;
    failedCount: number;
  };
  bucketBreakdown: Record<string, BucketBreakdown>;
  files: StorageFileEntry[];
}

type Tab = "users" | "reports" | "storage";

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

function formatDate(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  try {
    return format(new Date(iso), "d MMM yyyy, HH:mm", { locale: tr });
  } catch {
    return fallback;
  }
}

function formatRelative(iso: string | null | undefined, fallback = "Hiç giriş yapılmamış"): string {
  if (!iso) return fallback;
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: tr });
  } catch {
    return fallback;
  }
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
          <div className="grid grid-cols-2 gap-2">
            <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-0.5">Kayıt Tarihi</p>
              <p className="text-xs font-mono text-foreground font-medium">{formatDate(user.createdAt)}</p>
            </div>
            <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-0.5">Son Giriş</p>
              <p className="text-xs font-mono text-foreground font-medium">{formatRelative(user.lastLoginAt)}</p>
              {user.lastLoginAt && (
                <p className="text-[10px] font-mono text-muted-foreground">{formatDate(user.lastLoginAt)}</p>
              )}
            </div>
          </div>

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

function ReportCard({
  report,
  onDismiss,
  onDeleteFile,
}: {
  report: FileReport;
  onDismiss: (reportId: string) => Promise<void>;
  onDeleteFile: (reportId: string) => Promise<void>;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDismiss = async () => {
    setDismissing(true);
    try { await onDismiss(report.reportId); }
    finally { setDismissing(false); }
  };

  const handleDeleteFile = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try { await onDeleteFile(report.reportId); }
    finally { setDeleting(false); setConfirmDelete(false); }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-destructive/10 border border-destructive/20 flex items-center justify-center shrink-0">
              <Flag className="w-3.5 h-3.5 text-destructive" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-mono font-semibold text-foreground truncate max-w-xs">
                {report.dosyaAdi}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground">
                {format(new Date(report.tarih), "d MMM yyyy, HH:mm", { locale: tr })}
              </p>
            </div>
          </div>
          <a
            href={report.dosyaLinki}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0"
          >
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary">
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          </a>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
          <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40 space-y-0.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Paylaşan</p>
            <p className="text-foreground font-semibold">{report.yukleyenKullanici}</p>
          </div>
          <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40 space-y-0.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Şikayet Eden</p>
            <p className="text-foreground font-semibold">{report.sikayetEdenKullanici}</p>
          </div>
          <div className="px-3 py-2 rounded-lg bg-muted/30 border border-border/40 space-y-0.5 sm:col-span-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">IP Adresi</p>
            <p className="text-foreground">{report.sikayetEdenIp}</p>
          </div>
        </div>

        <div className="px-3 py-2.5 rounded-lg bg-destructive/5 border border-destructive/20">
          <p className="text-[10px] font-mono text-destructive/70 uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <FileText className="w-3 h-3" /> Şikayet Nedeni
          </p>
          <p className="text-xs font-mono text-foreground leading-relaxed whitespace-pre-wrap break-words">
            {report.sikayetNedeni}
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1 justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs font-mono text-muted-foreground gap-1.5 hover:text-foreground"
            disabled={dismissing || deleting}
            onClick={handleDismiss}
          >
            {dismissing
              ? <RefreshCw className="w-3 h-3 animate-spin" />
              : <XCircle className="w-3 h-3" />}
            {dismissing ? "Kapatılıyor…" : "Şikayeti Kapat"}
          </Button>

          {confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-mono text-destructive">Emin misiniz?</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs font-mono text-muted-foreground gap-1 h-7 px-2"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                İptal
              </Button>
              <Button
                size="sm"
                className="text-xs font-mono gap-1.5 h-7 bg-destructive hover:bg-destructive/90"
                disabled={deleting}
                onClick={handleDeleteFile}
              >
                {deleting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                {deleting ? "Siliniyor…" : "Evet, Sil"}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="text-xs font-mono gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={dismissing || deleting}
              onClick={handleDeleteFile}
            >
              <Trash2 className="w-3 h-3" /> Dosyayı Sil
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── StoragePanel Bileşeni ─────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: "r2" | "b2" | "unknown" }) {
  if (provider === "r2") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-orange-500/10 border border-orange-500/30 text-orange-400">
        <Cloud className="w-2.5 h-2.5" /> R2
      </span>
    );
  }
  if (provider === "b2") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-500/10 border border-red-500/30 text-red-400">
        <HardDrive className="w-2.5 h-2.5" /> B2
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted border border-border text-muted-foreground">
      ?
    </span>
  );
}

interface BucketTestResult {
  provider: "r2" | "b2";
  bucket: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}

interface StorageTestResponse {
  ok: boolean;
  results: BucketTestResult[];
}

function StoragePanel() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState(false);

  // Test state
  const [testingR2, setTestingR2] = useState(false);
  const [testingB2, setTestingB2] = useState(false);
  const [testResults, setTestResults] = useState<BucketTestResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/r2/stats", { credentials: "include" });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "İstatistikler alınamadı");
        return;
      }
      setStats(await res.json() as StorageStats);
    } catch {
      setError("Sunucuya ulaşılamadı");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const runTest = async (provider: "r2" | "b2" | "all") => {
    const setTesting = provider === "r2" ? setTestingR2 : provider === "b2" ? setTestingB2 : (v: boolean) => { setTestingR2(v); setTestingB2(v); };
    setTesting(true);
    setTestResults(null);
    setTestError(null);
    try {
      const res = await fetch("/api/admin/storage/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ provider }),
      });
      const data = await res.json() as StorageTestResponse & { error?: string };
      if (!res.ok) {
        setTestError(data.error ?? "Test başarısız");
        return;
      }
      // Provider-specific tests: merge results (preserve previous other-provider results)
      setTestResults((prev) => {
        const incoming = data.results;
        if (!prev || provider === "all") return incoming;
        const otherProviderResults = prev.filter((r) => r.provider !== provider);
        return [...otherProviderResults, ...incoming];
      });
    } catch {
      setTestError("Sunucuya ulaşılamadı");
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => { void load(); }, []);

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-border bg-card/60 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 border border-dashed border-destructive/30 rounded-xl">
        <ServerCrash className="w-8 h-8 text-destructive/50" />
        <p className="text-sm font-mono text-destructive">{error}</p>
        <Button variant="outline" size="sm" className="text-xs font-mono gap-2" onClick={() => load()}>
          <RefreshCw className="w-3.5 h-3.5" /> Tekrar Dene
        </Button>
      </div>
    );
  }

  if (!stats) return null;

  const bucketEntries = Object.entries(stats.bucketBreakdown);
  const encryptionPct = stats.totals.fileCount > 0
    ? Math.round((stats.totals.encryptedCount / stats.totals.fileCount) * 100)
    : 0;

  return (
    <div className="space-y-5">
      {/* Yenile butonu */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
          <BarChart3 className="w-3.5 h-3.5" />
          <span>Firebase kayıtlarından okunur — bulut servislerine ayrıca istek gönderilmez</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs font-mono gap-2"
          disabled={refreshing}
          onClick={() => void load(true)}
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Yenileniyor…" : "Yenile"}
        </Button>
      </div>

      {/* Servis Durum Kartları */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Cloudflare R2 */}
        <div className={`p-4 rounded-xl border flex items-center gap-3 ${stats.r2Configured ? "border-orange-500/30 bg-orange-500/5" : "border-border/60 bg-card/40"}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${stats.r2Configured ? "bg-orange-500/15 border border-orange-500/30" : "bg-muted border border-border"}`}>
            {stats.r2Configured ? <Cloud className="w-4 h-4 text-orange-400" /> : <CloudOff className="w-4 h-4 text-muted-foreground" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono font-bold text-foreground">Cloudflare R2</p>
            <p className={`text-[11px] font-mono ${stats.r2Configured ? "text-orange-400" : "text-muted-foreground"}`}>
              {stats.r2Configured
                ? `${stats.configuredBuckets.length} bucket aktif`
                : "Yapılandırılmamış"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {stats.r2Configured && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[10px] font-mono gap-1 text-orange-400 hover:text-orange-300 hover:bg-orange-500/10"
                disabled={testingR2}
                onClick={() => void runTest("r2")}
              >
                {testingR2
                  ? <RefreshCw className="w-3 h-3 animate-spin" />
                  : <UploadCloud className="w-3 h-3" />}
                {testingR2 ? "Test…" : "Test"}
              </Button>
            )}
            {stats.r2Configured
              ? <CheckCircle className="w-4 h-4 text-emerald-400" />
              : <XCircle className="w-4 h-4 text-muted-foreground/40" />}
          </div>
        </div>

        {/* Backblaze B2 */}
        <div className={`p-4 rounded-xl border flex items-center gap-3 ${stats.b2Configured ? "border-red-500/30 bg-red-500/5" : "border-border/60 bg-card/40"}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${stats.b2Configured ? "bg-red-500/15 border border-red-500/30" : "bg-muted border border-border"}`}>
            {stats.b2Configured ? <HardDrive className="w-4 h-4 text-red-400" /> : <HardDrive className="w-4 h-4 text-muted-foreground" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono font-bold text-foreground">Backblaze B2</p>
            <p className={`text-[11px] font-mono ${stats.b2Configured ? "text-red-400" : "text-muted-foreground"}`}>
              {stats.b2Configured
                ? `${stats.b2Buckets.length} bucket aktif`
                : "Yapılandırılmamış"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {stats.b2Configured && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[10px] font-mono gap-1 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                disabled={testingB2}
                onClick={() => void runTest("b2")}
              >
                {testingB2
                  ? <RefreshCw className="w-3 h-3 animate-spin" />
                  : <UploadCloud className="w-3 h-3" />}
                {testingB2 ? "Test…" : "Test"}
              </Button>
            )}
            {stats.b2Configured
              ? <CheckCircle className="w-4 h-4 text-emerald-400" />
              : <XCircle className="w-4 h-4 text-muted-foreground/40" />}
          </div>
        </div>

        {/* Firebase */}
        <div className={`p-4 rounded-xl border flex items-center gap-3 ${stats.firebaseConnected ? "border-yellow-500/30 bg-yellow-500/5" : "border-border/60 bg-card/40"}`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${stats.firebaseConnected ? "bg-yellow-500/15 border border-yellow-500/30" : "bg-muted border border-border"}`}>
            {stats.firebaseConnected ? <Wifi className="w-4 h-4 text-yellow-400" /> : <WifiOff className="w-4 h-4 text-muted-foreground" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono font-bold text-foreground">Firebase RTDB</p>
            <p className={`text-[11px] font-mono ${stats.firebaseConnected ? "text-yellow-400" : "text-muted-foreground"}`}>
              {stats.firebaseConnected ? "Bağlı" : "Bağlı değil"}
            </p>
          </div>
          <div className="ml-auto">
            {stats.firebaseConnected
              ? <CheckCircle className="w-4 h-4 text-emerald-400" />
              : <XCircle className="w-4 h-4 text-muted-foreground/40" />}
          </div>
        </div>
      </div>

      {/* Test Sonuçları */}
      {testError && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-destructive/30 bg-destructive/5 text-xs font-mono text-destructive">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{testError}</span>
          <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setTestError(null)}>
            <XCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {testResults && testResults.length > 0 && (
        <div className="rounded-xl border border-border/60 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/20">
            <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <UploadCloud className="w-3 h-3" /> Bağlantı Test Sonuçları
            </p>
            <button
              className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => { setTestResults(null); setTestError(null); }}
            >
              Temizle
            </button>
          </div>
          <div className="divide-y divide-border/30">
            {testResults.map((r, i) => (
              <div key={i} className={`flex items-center gap-3 px-3 py-2.5 ${r.success ? "" : "bg-destructive/3"}`}>
                <ProviderBadge provider={r.provider} />
                <span className="text-xs font-mono text-foreground flex-1 truncate">{r.bucket}</span>
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">{r.latencyMs} ms</span>
                {r.success ? (
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                    {r.error && (
                      <span className="text-[10px] font-mono text-destructive truncate max-w-[200px]" title={r.error}>
                        {r.error}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toplam İstatistikler */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Toplam Dosya", value: stats.totals.fileCount.toLocaleString("tr-TR"), icon: FileText, accent: "" },
          { label: "Toplam Boyut", value: formatBytes(stats.totals.totalBytes), icon: Database, accent: "" },
          { label: "Şifreli", value: `${stats.totals.encryptedCount} (${encryptionPct}%)`, icon: Lock, accent: "" },
          { label: "Şifresiz", value: String(stats.totals.unencryptedCount), icon: AlertTriangle, accent: "" },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="p-3 rounded-xl border border-border/60 bg-card/60">
            <div className="flex items-center gap-1.5 mb-1">
              <Icon className="w-3 h-3 text-muted-foreground" />
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{label}</p>
            </div>
            <p className="text-sm font-mono font-bold text-foreground">{value}</p>
          </div>
        ))}
      </div>

      {/* Cloud Upload Durumu — sadece sorun varsa göster */}
      {((stats.totals.pendingCount ?? 0) > 0 || (stats.totals.failedCount ?? 0) > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(stats.totals.pendingCount ?? 0) > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-xl border border-yellow-500/30 bg-yellow-500/5">
              <RefreshCw className="w-4 h-4 text-yellow-400 animate-spin shrink-0" />
              <div>
                <p className="text-xs font-mono font-semibold text-yellow-400">
                  {stats.totals.pendingCount} dosya yükleniyor
                </p>
                <p className="text-[10px] font-mono text-muted-foreground">
                  Bulut yedekleme devam ediyor
                </p>
              </div>
            </div>
          )}
          {(stats.totals.failedCount ?? 0) > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-xl border border-destructive/30 bg-destructive/5">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
              <div>
                <p className="text-xs font-mono font-semibold text-destructive">
                  {stats.totals.failedCount} dosya bulut yedeği başarısız
                </p>
                <p className="text-[10px] font-mono text-muted-foreground">
                  Dosyalar disk'ten erişilebilir, bulut yedek yok
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bucket Dağılımı */}
      {bucketEntries.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" /> Bucket Dağılımı
          </p>
          <div className="space-y-2">
            {bucketEntries.map(([key, bd]) => {
              const pct = stats.totals.totalBytes > 0
                ? Math.min(100, (bd.totalBytes / stats.totals.totalBytes) * 100)
                : 0;
              return (
                <div key={key} className="p-3 rounded-xl border border-border/60 bg-card/60">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderBadge provider={bd.provider} />
                      <span className="text-xs font-mono text-foreground font-medium truncate">
                        {key.replace(/^\[(r2|b2|unknown)\] /, "")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-3">
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {bd.fileCount} dosya
                      </span>
                      <span className="text-[11px] font-mono font-semibold text-foreground">
                        {formatBytes(bd.totalBytes)}
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${bd.provider === "b2" ? "bg-red-400" : bd.provider === "r2" ? "bg-orange-400" : "bg-muted-foreground"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[10px] font-mono text-muted-foreground mt-1">
                    Toplam boyutun %{pct.toFixed(1)}'i
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Dosya Listesi */}
      {stats.files.length > 0 && (
        <div className="space-y-2">
          <button
            className="flex items-center gap-2 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpandedFiles((v) => !v)}
          >
            <FileText className="w-3.5 h-3.5" />
            Tüm Dosyalar ({stats.files.length})
            {expandedFiles ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {expandedFiles && (
            <div className="rounded-xl border border-border/60 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/30">
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Dosya Adı</th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Servis</th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Bucket</th>
                      <th className="text-right px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Boyut</th>
                      <th className="text-center px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Bulut</th>
                      <th className="text-center px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Şifre</th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Yüklenme</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.files.map((f, idx) => {
                      const rowAccent =
                        f.cloudStatus === "failed" ? "bg-destructive/5" :
                        f.cloudStatus === "pending" ? "bg-yellow-500/5" :
                        idx % 2 !== 0 ? "bg-muted/5" : "";
                      return (
                        <tr
                          key={f.fileId}
                          className={`border-b border-border/30 hover:bg-muted/20 transition-colors ${rowAccent}`}
                          title={f.cloudError ? `Hata: ${f.cloudError}` : undefined}
                        >
                          <td className="px-3 py-2.5 max-w-[200px]">
                            <p className="truncate text-foreground font-medium">{f.name}</p>
                            <p className="text-[10px] text-muted-foreground">{f.mimeType}</p>
                          </td>
                          <td className="px-3 py-2.5">
                            <ProviderBadge provider={f.provider} />
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground max-w-[120px]">
                            <span className="truncate block">{f.bucket}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right text-foreground whitespace-nowrap">
                            {formatBytes(f.size)}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {f.cloudStatus === "ready" && <CheckCircle className="w-3 h-3 text-emerald-400 mx-auto" />}
                            {f.cloudStatus === "pending" && <RefreshCw className="w-3 h-3 text-yellow-400 animate-spin mx-auto" />}
                            {f.cloudStatus === "failed" && <XCircle className="w-3 h-3 text-destructive mx-auto" title={f.cloudError} />}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {f.encrypted
                              ? <Lock className="w-3 h-3 text-emerald-400 mx-auto" />
                              : <AlertTriangle className="w-3 h-3 text-muted-foreground/40 mx-auto" />}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                            {formatDate(f.uploadedAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {stats.totals.fileCount === 0 && (
        <div className="text-center py-16 border border-dashed border-border/40 rounded-xl">
          <HardDrive className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground font-mono">Firebase'de kayıtlı dosya yok</p>
          <p className="text-xs text-muted-foreground/60 font-mono mt-1">
            Dosya yüklendikçe burada görünecek.
          </p>
        </div>
      )}
    </div>
  );
}

// ── AdminPage ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [defaults, setDefaults] = useState<ServerDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reports, setReports] = useState<FileReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  // Kullanıcı + default limitleri çeker, state'e yazar.
  // Yükleme göstergesi yönetimi loadAll'a bırakılmıştır.
  const fetchUsers = async () => {
    const [usersRes, defaultsRes] = await Promise.all([
      fetch("/api/admin/users", { credentials: "include" }),
      fetch("/api/admin/defaults", { credentials: "include" }),
    ]);
    if (usersRes.ok) setUsers(await usersRes.json() as AdminUser[]);
    if (defaultsRes.ok) setDefaults(await defaultsRes.json() as ServerDefaults);
  };

  // Şikayetleri çeker, state'e yazar.
  const fetchReports = async () => {
    const res = await fetch("/api/admin/reports", { credentials: "include" });
    if (res.ok) setReports(await res.json() as FileReport[]);
    else toast({ variant: "destructive", title: "Şikayetler yüklenemedi" });
  };

  // Tüm verileri çeker.
  // silent=false → ilk yükleme göstergesi (loading/reportsLoading)
  // silent=true  → sessiz yenileme (refreshing spinner)
  const loadAll = async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setReportsLoading(true);
    }
    try {
      await Promise.all([fetchUsers(), fetchReports()]);
    } catch {
      toast({ variant: "destructive", title: "Veriler yüklenemedi" });
    } finally {
      setLoading(false);
      setReportsLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { void loadAll(); }, []);

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
    await fetchUsers();
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
    await fetchUsers();
  };

  const handleDismissReport = async (reportId: string) => {
    const res = await fetch(`/api/admin/reports/${reportId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      const err = await res.json() as { error?: string };
      toast({ variant: "destructive", title: err.error ?? "Şikayet kapatılamadı" });
      return;
    }
    toast({ title: "Şikayet kapatıldı" });
    setReports((prev) => prev.filter((r) => r.reportId !== reportId));
  };

  const handleDeleteReportedFile = async (reportId: string) => {
    const res = await fetch(`/api/admin/reports/${reportId}/file`, {
      method: "DELETE",
      credentials: "include",
    });
    const data = await res.json() as { ok?: boolean; fileDeleted?: boolean; error?: string };
    if (!res.ok) {
      toast({ variant: "destructive", title: data.error ?? "İşlem başarısız" });
      return;
    }
    toast({
      title: data.fileDeleted ? "Dosya silindi ve şikayet kapatıldı ✓" : "Şikayet kapatıldı (dosya zaten silinmişti)",
    });
    setReports((prev) => prev.filter((r) => r.reportId !== reportId));
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
          <p className="text-muted-foreground text-sm">Platform yönetimi ve içerik denetimi</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-xs font-mono"
          disabled={refreshing}
          onClick={() => loadAll(true)}
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

      <div className="flex gap-1 p-1 rounded-xl bg-muted/40 border border-border/60 w-fit">
        <button
          onClick={() => setActiveTab("users")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono transition-all ${
            activeTab === "users"
              ? "bg-card border border-border/60 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          Kullanıcılar
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "users" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            {users.length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab("reports")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono transition-all ${
            activeTab === "reports"
              ? "bg-card border border-border/60 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Flag className="w-3.5 h-3.5" />
          Şikayetler
          {reports.length > 0 && (
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
              activeTab === "reports"
                ? "bg-destructive/10 text-destructive"
                : "bg-destructive/20 text-destructive animate-pulse"
            }`}>
              {reports.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("storage")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono transition-all ${
            activeTab === "storage"
              ? "bg-card border border-border/60 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <HardDrive className="w-3.5 h-3.5" />
          Depolama
        </button>
      </div>

      {activeTab === "users" && (
        <>
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
        </>
      )}

      {activeTab === "storage" && <StoragePanel />}

      {activeTab === "reports" && (
        <>
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <Flag className="w-3.5 h-3.5" />
            <span>{reports.length} açık şikayet</span>
            {reports.length > 0 && (
              <>
                <AlertTriangle className="w-3.5 h-3.5 ml-2 text-amber-400" />
                <span className="text-amber-400">İnceleme bekliyor</span>
              </>
            )}
          </div>

          {reportsLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-48 rounded-xl border border-border bg-card/60 animate-pulse" />
              ))}
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-border/40 rounded-xl">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-3">
                <CheckCircle className="w-5 h-5 text-emerald-400" />
              </div>
              <p className="text-sm text-muted-foreground font-mono">Açık şikayet yok</p>
              <p className="text-xs text-muted-foreground/60 font-mono mt-1">Tüm şikayetler incelendi.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map((r) => (
                <ReportCard
                  key={r.reportId}
                  report={r}
                  onDismiss={handleDismissReport}
                  onDeleteFile={handleDeleteReportedFile}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
