import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import {
  Copy, Download, Trash2, Terminal, ArrowLeft, Layers,
  FileCode2, Check, Link2, Clock, Loader2, GitBranch, Plus,
  Lock, Eye, EyeOff, Shield, LogIn, KeyRound, Flag, User,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { tr } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";

interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
  chunkSize: number;
  uploadedAt: string;
  expiresAt?: string;
  sha256?: string;
  groupId?: string;
  version?: number;
  chunkUrls?: string[];
  isOwner: boolean;
  requireLogin: boolean;
  hasPassword: boolean;
  uploaderUsername?: string;
}

interface AccessError {
  requireLogin?: boolean;
  requirePassword?: boolean;
}

interface VersionMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  version?: number;
}

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function MetaRow({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider shrink-0">{label}</span>
      <span className={`text-xs font-mono text-right ${className ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

function VersionHistory({ groupId, currentFileId }: { groupId: string; currentFileId: string }) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/files/group/${groupId}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : [])
      .then((data) => setVersions(data as VersionMeta[]))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [groupId]);

  if (loading) return <div className="h-8 animate-pulse bg-muted rounded-lg" />;
  if (versions.length < 2) return null;

  return (
    <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="font-mono text-sm flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-primary" />
          Versiyon Geçmişi
          <span className="ml-auto text-xs font-normal text-muted-foreground font-sans">{versions.length} versiyon</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {[...versions].reverse().map((v) => {
          const isCurrent = v.id === currentFileId;
          return (
            <div key={v.id} className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all ${isCurrent ? "border-primary/30 bg-primary/5" : "border-border/40 bg-muted/10 hover:bg-muted/20"}`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-xs font-mono font-bold shrink-0 ${isCurrent ? "text-primary" : "text-muted-foreground"}`}>v{v.version ?? "?"}</span>
                <span className="text-xs font-mono text-foreground truncate max-w-[180px]">{v.name}</span>
                {isCurrent && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary shrink-0">şu an</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground font-mono hidden sm:block">{format(new Date(v.uploadedAt), "d MMM yyyy", { locale: tr })}</span>
                {!isCurrent && (
                  <Link href={`/files/${v.id}`}>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] font-mono">Görüntüle</Button>
                  </Link>
                )}
              </div>
            </div>
          );
        })}
        <div className="pt-1">
          <Link href={`/?parentFileId=${currentFileId}`}>
            <Button variant="outline" size="sm" className="w-full gap-2 text-xs font-mono">
              <Plus className="w-3.5 h-3.5" /> Yeni Versiyon Yükle
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FileDetailPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [file, setFile] = useState<FileMeta | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState<AccessError | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [showUnlockPw, setShowUnlockPw] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedDirectLink, setCopiedDirectLink] = useState(false);

  const [settingsRequireLogin, setSettingsRequireLogin] = useState(false);
  const [settingsHasPassword, setSettingsHasPassword] = useState(false);
  const [settingsNewPassword, setSettingsNewPassword] = useState("");
  const [showSettingsPw, setShowSettingsPw] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reporting, setReporting] = useState(false);
  const [reportSent, setReportSent] = useState(false);

  const loadFile = (id: string) => {
    setLoading(true);
    setAccessError(null);
    fetch(`/api/files/${id}`, { credentials: "include" })
      .then(async (r) => {
        if (r.ok) {
          const meta = await r.json() as FileMeta;
          setFile(meta);
          setSettingsRequireLogin(meta.requireLogin);
          setSettingsHasPassword(meta.hasPassword);
          if (meta.isOwner) {
            fetch(`/api/files/${id}/snippet`, { credentials: "include" })
              .then((sr) => sr.ok ? sr.json() : null)
              .then((d) => setSnippet((d as { snippet?: string } | null)?.snippet ?? null))
              .catch(() => {});
          }
        } else {
          const err = await r.json() as AccessError & { error?: string };
          if (err.requireLogin) {
            setAccessError({ requireLogin: true });
          } else if (err.requirePassword) {
            setAccessError({ requirePassword: true });
          } else {
            setFile(null);
          }
        }
      })
      .catch(() => setFile(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!fileId) return;
    loadFile(fileId);
  }, [fileId]);

  const unlockFile = async () => {
    if (!fileId || !unlockPassword) return;
    setUnlocking(true);
    try {
      const res = await fetch(`/api/files/${fileId}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: unlockPassword }),
      });
      if (res.ok) {
        setUnlockPassword("");
        loadFile(fileId);
      } else {
        const err = await res.json() as { error?: string };
        toast({ variant: "destructive", title: err.error ?? "Yanlış şifre" });
      }
    } catch {
      toast({ variant: "destructive", title: "Bağlantı hatası" });
    } finally {
      setUnlocking(false);
    }
  };

  const saveSettings = async () => {
    if (!fileId || !file) return;
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = { requireLogin: settingsRequireLogin };
      if (!settingsHasPassword) {
        body.password = null;
      } else if (settingsNewPassword) {
        body.password = settingsNewPassword;
      }
      const res = await fetch(`/api/files/${fileId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated = await res.json() as FileMeta;
        setFile(updated);
        setSettingsRequireLogin(updated.requireLogin);
        setSettingsHasPassword(updated.hasPassword);
        setSettingsNewPassword("");
        toast({ title: "Erişim ayarları kaydedildi" });
      } else {
        const err = await res.json() as { error?: string };
        toast({ variant: "destructive", title: err.error ?? "Kaydetme başarısız" });
      }
    } catch {
      toast({ variant: "destructive", title: "Bağlantı hatası" });
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteFile = async () => {
    if (!file || !confirm(`"${file.name}" silinsin mi?`)) return;
    const res = await fetch(`/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
    if (res.ok) { toast({ title: "Dosya silindi" }); setLocation("/files"); }
    else toast({ variant: "destructive", title: "Silme başarısız" });
  };

  const reportFile = async () => {
    if (!fileId || !reportReason.trim()) return;
    if (reportReason.trim().length < 10) {
      toast({ variant: "destructive", title: "Şikayet nedeni en az 10 karakter olmalıdır" });
      return;
    }
    setReporting(true);
    try {
      const res = await fetch(`/api/files/${fileId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason: reportReason.trim() }),
      });
      const data = await res.json() as { ok?: boolean; message?: string; error?: string };
      if (res.ok && data.ok) {
        setReportSent(true);
        setReportReason("");
        toast({ title: "Şikayet gönderildi", description: data.message });
      } else {
        toast({ variant: "destructive", title: data.error ?? "Şikayet gönderilemedi" });
      }
    } catch {
      toast({ variant: "destructive", title: "Bağlantı hatası" });
    } finally {
      setReporting(false);
    }
  };

  const copy = async (text: string, type: "snippet" | "link" | "directLink") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "snippet") { setCopiedSnippet(true); setTimeout(() => setCopiedSnippet(false), 2000); }
      else if (type === "directLink") { setCopiedDirectLink(true); setTimeout(() => setCopiedDirectLink(false), 2000); }
      else { setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); }
    } catch { toast({ variant: "destructive", title: "Kopyalanamadı" }); }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6 animate-pulse">
        <div className="h-8 bg-muted rounded-lg w-1/3" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="h-48 bg-card rounded-xl border border-border" />
          </div>
          <div className="h-72 bg-card rounded-xl border border-border" />
        </div>
      </div>
    );
  }

  if (accessError?.requireLogin) {
    return (
      <div className="max-w-md mx-auto py-24 text-center space-y-5">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
          <LogIn className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-mono font-bold mb-1">Giriş Gerekli</h2>
          <p className="text-sm text-muted-foreground">Bu dosyayı görüntülemek için bir hesabınızın olması gerekiyor.</p>
        </div>
        {user ? (
          <p className="text-xs text-muted-foreground font-mono">Hesabınız bu dosyaya erişim iznine sahip değil.</p>
        ) : (
          <Link href="/login">
            <Button className="gap-2 font-mono text-xs">
              <LogIn className="w-3.5 h-3.5" /> Giriş Yap
            </Button>
          </Link>
        )}
      </div>
    );
  }

  if (accessError?.requirePassword) {
    return (
      <div className="max-w-md mx-auto py-24 space-y-6">
        <div className="text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-mono font-bold mb-1">Şifre Korumalı Dosya</h2>
            <p className="text-sm text-muted-foreground">Bu dosyayı görüntülemek için şifreyi girmeniz gerekiyor.</p>
          </div>
        </div>
        <Card className="border-primary/20">
          <CardContent className="pt-6 space-y-4">
            <div className="relative">
              <Input
                type={showUnlockPw ? "text" : "password"}
                placeholder="Dosya şifresi"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlockFile()}
                className="font-mono text-sm pr-10"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowUnlockPw((p) => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showUnlockPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <Button
              className="w-full gap-2 font-mono text-xs"
              onClick={unlockFile}
              disabled={!unlockPassword || unlocking}
            >
              {unlocking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
              {unlocking ? "Doğrulanıyor..." : "Dosyayı Aç"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="text-center py-24">
        <FileCode2 className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
        <h2 className="text-xl font-mono font-bold mb-2">Dosya bulunamadı</h2>
        <p className="text-muted-foreground text-sm mb-6">Bu dosya mevcut değil, silinmiş ya da süresi dolmuş.</p>
        <Link href="/files"><Button className="font-mono text-xs">Kütüphaneye Dön</Button></Link>
      </div>
    );
  }

  const downloadUrl = `/api/files/${fileId}/download`;
  const directDownloadUrl = `${window.location.origin}${downloadUrl}`;
  const shareUrl = `${window.location.origin}/files/${fileId}`;
  const isExpired = file.expiresAt ? new Date(file.expiresAt) < new Date() : false;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link href="/files">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground mt-0.5 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold font-mono text-foreground truncate max-w-xl">{file.name}</h1>
              {file.version !== undefined && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10px] font-mono shrink-0">
                  <GitBranch className="w-2.5 h-2.5" /> v{file.version}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">{formatBytes(file.size)}</span>
              <span className="text-muted-foreground/30 text-xs">·</span>
              <span className="text-xs text-muted-foreground">{format(new Date(file.uploadedAt), "d MMM yyyy HH:mm", { locale: tr })}</span>
              {file.uploaderUsername && (
                <>
                  <span className="text-muted-foreground/30 text-xs">·</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                    <User className="w-3 h-3" />
                    {file.uploaderUsername}
                  </span>
                </>
              )}
              {file.expiresAt && (
                <>
                  <span className="text-muted-foreground/30 text-xs">·</span>
                  <span className={`flex items-center gap-1 text-xs font-mono ${isExpired ? "text-destructive" : "text-amber-400"}`}>
                    <Clock className="w-3 h-3" />
                    {isExpired ? "Süresi doldu" : `${formatDistanceToNow(new Date(file.expiresAt), { addSuffix: true, locale: tr })} silinicek`}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" className="gap-2 text-xs font-mono" onClick={() => copy(shareUrl, "link")}>
            {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Link2 className="w-3.5 h-3.5" />}
            {copiedLink ? "Kopyalandı!" : "Sayfa Linki"}
          </Button>
          <Button variant="outline" size="sm" className="gap-2 text-xs font-mono" onClick={() => copy(directDownloadUrl, "directLink")}>
            {copiedDirectLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedDirectLink ? "Kopyalandı!" : "Direkt Link"}
          </Button>
          <a href={downloadUrl} download={file.name}>
            <Button size="sm" variant="secondary" className="gap-2 text-xs font-mono">
              <Download className="w-3.5 h-3.5" /> İndir
            </Button>
          </a>
          {!file.isOwner && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2 text-xs font-mono border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => { setReportSent(false); setReportOpen(true); }}
            >
              <Flag className="w-3.5 h-3.5" /> Şikayet Et
            </Button>
          )}
          {file.isOwner && (
            <Button size="sm" variant="destructive" className="gap-2 text-xs font-mono" onClick={deleteFile}>
              <Trash2 className="w-3.5 h-3.5" /> Sil
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <>
            {file.isOwner && snippet && (
                <Card className="border-border/60 bg-card/60">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 font-mono text-sm">
                      <Terminal className="w-4 h-4 text-primary" /> JS Embed Snippet
                    </CardTitle>
                    <CardDescription className="text-xs">Bu snippet'i herhangi bir HTML sayfasına yapıştırarak indirme butonu ekleyin.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="relative">
                      <div className="absolute right-3 top-3 z-10">
                        <Button size="sm" variant="secondary" className="h-7 px-3 font-mono text-xs" onClick={() => copy(snippet, "snippet")}>
                          {copiedSnippet ? <Check className="w-3 h-3 mr-1.5 text-emerald-400" /> : <Copy className="w-3 h-3 mr-1.5" />}
                          {copiedSnippet ? "Kopyalandı" : "Kopyala"}
                        </Button>
                      </div>
                      <pre className="p-4 rounded-lg bg-[#050a0a] border border-primary/10 text-emerald-400 font-mono text-xs overflow-x-auto leading-relaxed">
                        <code>{snippet}</code>
                      </pre>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card className="border-border/60 bg-card/60">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 font-mono text-sm">
                    <Layers className="w-4 h-4 text-primary" /> Ham Parçalar
                    <span className="ml-auto text-xs font-normal text-muted-foreground font-sans">{file.chunkCount} parça</span>
                  </CardTitle>
                  <CardDescription className="text-xs">Bölünmüş parçalara doğrudan erişim.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1.5">
                    {Array.from({ length: Math.min(file.chunkCount, 50) }).map((_, i) => {
                      const chunkUrl = `/api/files/${fileId}/chunks/${i}`;
                      return (
                        <div key={i} className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 group">
                          <div className="flex items-center gap-3">
                            <FileCode2 className="w-3.5 h-3.5 text-primary/60" />
                            <span className="font-mono text-xs text-muted-foreground">chunk_<span className="text-foreground">{String(i).padStart(3, "0")}</span>.bin</span>
                          </div>
                          <a href={chunkUrl} download={`${file.name}.part${i}`} onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100">
                              <Download className="w-3.5 h-3.5" />
                            </Button>
                          </a>
                        </div>
                      );
                    })}
                    {file.chunkCount > 50 && (
                      <p className="text-xs text-center text-muted-foreground font-mono pt-2">ve {file.chunkCount - 50} parça daha…</p>
                    )}
                  </div>
                </CardContent>
              </Card>
          </>
        </div>

        <div className="space-y-5">
          <Card className="border-border/60 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <MetaRow label="Tür" value="Sunucuda saklandı" />
              <MetaRow label="MIME" value={file.mimeType || "application/octet-stream"} />
              <MetaRow label="Boyut" value={formatBytes(file.size)} />
              <MetaRow label="Parça boyutu" value={formatBytes(file.chunkSize)} />
              <MetaRow label="Parça sayısı" value={`${file.chunkCount} adet`} />
              {file.expiresAt && (
                <MetaRow label="Son tarih" value={format(new Date(file.expiresAt), "d MMM yyyy HH:mm", { locale: tr })} className={isExpired ? "text-destructive" : "text-amber-400"} />
              )}
            </CardContent>
          </Card>

          {file.isOwner && file.groupId && <VersionHistory groupId={file.groupId} currentFileId={fileId} />}

          <Card className="border-border/60 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm flex items-center gap-2">
                <Link2 className="w-3.5 h-3.5 text-primary" /> Paylaşım Linki
              </CardTitle>
              <CardDescription className="text-xs">Bu sayfaya gelen herkes dosyayı görür ve indirebilir. Direkt link gömmez, önce önizleme sayfası açılır.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                <code className="text-xs font-mono text-muted-foreground break-all leading-relaxed">{shareUrl}</code>
              </div>
              <Button className="w-full gap-2 text-xs font-mono" onClick={() => copy(shareUrl, "link")}>
                {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedLink ? "Kopyalandı!" : "Sayfa Linkini Kopyala"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm flex items-center gap-2">
                <Download className="w-3.5 h-3.5 text-primary" /> Direkt İndirme Linki
              </CardTitle>
              <CardDescription className="text-xs">Tıklandığı anda dosya indirmeye başlar. Başka bir siteye buton/&lt;a&gt; olarak gömmek için uygundur.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                <code className="text-xs font-mono text-muted-foreground break-all leading-relaxed">{directDownloadUrl}</code>
              </div>
              <Button className="w-full gap-2 text-xs font-mono" onClick={() => copy(directDownloadUrl, "directLink")}>
                {copiedDirectLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedDirectLink ? "Kopyalandı!" : "Direkt Linki Kopyala"}
              </Button>
              <a href={downloadUrl} download={file.name} className="block">
                <Button variant="outline" className="w-full gap-2 text-xs font-mono">
                  <Download className="w-3.5 h-3.5" /> Dosyayı İndir
                </Button>
              </a>
            </CardContent>
          </Card>

          {file.isOwner && (
            <Card className="border-border/60 bg-card/60">
              <CardHeader className="pb-3">
                <CardTitle className="font-mono text-sm flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-primary" /> Erişim Ayarları
                </CardTitle>
                <CardDescription className="text-xs">Bu dosyaya kimlerin erişebileceğini belirleyin.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-mono font-medium">Yalnızca üyelere göster</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Açık olduğunda yalnızca giriş yapmış kullanıcılar dosyayı görebilir.</p>
                  </div>
                  <Switch
                    checked={settingsRequireLogin}
                    onCheckedChange={setSettingsRequireLogin}
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-mono font-medium">Şifre koruması</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Dosyayı açmak için şifre girilmesi zorunlu olur.</p>
                    </div>
                    <Switch
                      checked={settingsHasPassword}
                      onCheckedChange={(v) => {
                        setSettingsHasPassword(v);
                        if (!v) setSettingsNewPassword("");
                      }}
                    />
                  </div>

                  {settingsHasPassword && (
                    <div className="relative">
                      <Input
                        type={showSettingsPw ? "text" : "password"}
                        placeholder={file.hasPassword ? "Yeni şifre (boş bırakılırsa değişmez)" : "Şifre belirleyin"}
                        value={settingsNewPassword}
                        onChange={(e) => setSettingsNewPassword(e.target.value)}
                        className="font-mono text-xs pr-10"
                        maxLength={128}
                      />
                      <button
                        type="button"
                        onClick={() => setShowSettingsPw((p) => !p)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showSettingsPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  )}
                </div>

                <Button
                  className="w-full gap-2 text-xs font-mono"
                  onClick={saveSettings}
                  disabled={savingSettings || (settingsHasPassword && !settingsNewPassword && !file.hasPassword)}
                >
                  {savingSettings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {savingSettings ? "Kaydediliyor..." : "Ayarları Kaydet"}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── Şikayet Dialogu ───────────────────────────────────────────── */}
      <Dialog open={reportOpen} onOpenChange={(open) => { setReportOpen(open); if (!open) { setReportSent(false); setReportReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono flex items-center gap-2">
              <Flag className="w-4 h-4 text-destructive" />
              Dosyayı Şikayet Et
            </DialogTitle>
            <DialogDescription className="text-xs">
              {file?.uploaderUsername && (
                <span className="block mb-1 font-mono text-muted-foreground">
                  Paylaşan: <span className="text-foreground">{file.uploaderUsername}</span>
                </span>
              )}
              Şikayet nedeninizi açıklayın. Ekibimiz en kısa sürede inceleyecektir.
            </DialogDescription>
          </DialogHeader>

          {reportSent ? (
            <div className="py-6 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <Check className="w-5 h-5 text-emerald-400" />
              </div>
              <p className="text-sm font-mono text-foreground">Şikayetiniz alındı.</p>
              <p className="text-xs text-muted-foreground">İnceleme ekibimiz değerlendirecek.</p>
              <Button className="w-full text-xs font-mono mt-2" variant="outline" onClick={() => setReportOpen(false)}>
                Kapat
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-3 py-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-muted-foreground">Şikayet Nedeni</label>
                  <Textarea
                    placeholder="Dosyanın neden uygunsuz veya kurallara aykırı olduğunu açıklayın... (en az 10 karakter)"
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)}
                    className="font-mono text-xs resize-none min-h-[120px]"
                    maxLength={1000}
                    disabled={reporting}
                    autoFocus
                  />
                  <p className="text-[11px] text-muted-foreground text-right font-mono">
                    {reportReason.length} / 1000
                  </p>
                </div>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs font-mono"
                  onClick={() => setReportOpen(false)}
                  disabled={reporting}
                >
                  İptal
                </Button>
                <Button
                  size="sm"
                  className="gap-2 text-xs font-mono bg-destructive hover:bg-destructive/90"
                  onClick={reportFile}
                  disabled={reporting || reportReason.trim().length < 10}
                >
                  {reporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flag className="w-3.5 h-3.5" />}
                  {reporting ? "Gönderiliyor..." : "Şikayeti Gönder"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
