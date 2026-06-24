import { useState, useEffect } from "react";
import {
  Users, Settings, RefreshCw, CheckCircle, AlertCircle,
  RotateCcw, ChevronDown, ChevronUp, Database, UploadCloud, Layers,
  Shield, Flag, Trash2, ExternalLink, XCircle, AlertTriangle, FileText,
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

type Tab = "users" | "reports";

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

export default function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [defaults, setDefaults] = useState<ServerDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reports, setReports] = useState<FileReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  const loadUsers = async (silent = false) => {
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
      toast({ variant: "destructive", title: "Kullanıcı verileri yüklenemedi" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadReports = async (silent = false) => {
    if (!silent) setReportsLoading(true);
    try {
      const res = await fetch("/api/admin/reports", { credentials: "include" });
      if (res.ok) setReports(await res.json() as FileReport[]);
      else toast({ variant: "destructive", title: "Şikayetler yüklenemedi" });
    } catch {
      toast({ variant: "destructive", title: "Şikayetler yüklenemedi" });
    } finally {
      setReportsLoading(false);
    }
  };

  const loadAll = async (silent = false) => {
    if (!silent) { setLoading(true); setReportsLoading(true); }
    else setRefreshing(true);
    await Promise.all([loadUsers(true), loadReports(true)]);
    if (!silent) { setLoading(false); setReportsLoading(false); }
    else setRefreshing(false);
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
    await loadUsers(true);
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
    await loadUsers(true);
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
