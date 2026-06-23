import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import {
  Copy, Download, Trash2, Terminal, ArrowLeft, Layers,
  FileCode2, Check, Link2, Clock, Radio, WifiOff, Loader2, GitBranch, Plus,
  Lock, Eye, EyeOff, Shield, LogIn, KeyRound,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { tr } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { SHA256Stream } from "@/lib/sha256";

interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
  chunkSize: number;
  uploadedAt: string;
  expiresAt?: string;
  seedOnly?: boolean;
  sha256?: string;
  groupId?: string;
  version?: number;
  chunkUrls?: string[];
  isOwner: boolean;
  requireLogin: boolean;
  hasPassword: boolean;
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

type P2PStatus = "idle" | "connecting" | "receiving" | "done" | "error" | "offline";
type SeederPresence = "checking" | "online" | "offline" | "unknown";

const CONNECT_TIMEOUT_MS = 30_000;

function P2PDownloader({ fileId, fileName, fileSize, mimeType }: { fileId: string; fileName: string; fileSize: number; mimeType: string }) {
  const [status, setStatus] = useState<P2PStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [presence, setPresence] = useState<SeederPresence>("checking");
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // BUG-01 fix: queue ICE candidates that arrive before setRemoteDescription completes
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteReadyRef = useRef(false);
  // BUG-06 fix: connection timeout handle
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BUG-I fix: auto-reconnect on ICE failure — cap at MAX_RETRIES to avoid infinite loop
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 3;

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "seeder-status", fileId }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      if (msg.type === "seeder-status" && msg.fileId === fileId) {
        setPresence(msg.online ? "online" : "offline");
        ws.close();
      }
    };
    ws.onerror = () => setPresence("unknown");
    const timeout = setTimeout(() => { setPresence((prev) => prev === "checking" ? "unknown" : prev); ws.close(); }, 5000);
    return () => { clearTimeout(timeout); ws.close(); };
  }, [fileId]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      wsRef.current?.close();
      pcRef.current?.close();
    };
  }, []);

  const cancelDownload = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    wsRef.current?.close();
    pcRef.current?.close();
    pcRef.current = null;
    pendingCandidatesRef.current = [];
    remoteReadyRef.current = false;
    setStatus("idle");
    setErrorMsg("");
  };

  const startDownload = (isRetry = false) => {
    if (!isRetry) retryCountRef.current = 0;
    setStatus("connecting"); setProgress(0); setErrorMsg("");
    pendingCandidatesRef.current = [];
    remoteReadyRef.current = false;

    // BUG-06 fix: abort after CONNECT_TIMEOUT_MS if seeder never completes handshake
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      wsRef.current?.close();
      pcRef.current?.close();
      pcRef.current = null;
      pendingCandidatesRef.current = [];
      remoteReadyRef.current = false;
      setStatus("error");
      setErrorMsg(`Bağlantı zaman aşımı (${CONNECT_TIMEOUT_MS / 1000}s). Seeder yanıt vermedi.`);
    }, CONNECT_TIMEOUT_MS);

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "leech", fileId }));
    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;

      if (msg.type === "seeder-offline") {
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        setStatus("offline");
        setErrorMsg("Seeder çevrimdışı. Dosya sahibinin tarayıcısı açık değil.");
        ws.close();
        return;
      }

      if (msg.type === "offer") {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        pcRef.current = pc;
        pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: "ice", to: msg.from, candidate: e.candidate })); };

        // BUG-I fix: auto-reconnect on ICE failure (up to MAX_RETRIES times)
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") {
            ws.close();
            pc.close();
            if (retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current++;
              setErrorMsg(`Bağlantı kesildi — yeniden deneniyor (${retryCountRef.current}/${MAX_RETRIES})…`);
              setTimeout(() => startDownload(true), 2_000);
            } else {
              setStatus("error");
              setErrorMsg(`ICE bağlantısı başarısız oldu. ${MAX_RETRIES} otomatik deneme tükendi.`);
            }
          }
        };

        const receivedChunks: ArrayBuffer[] = [];
        let headerParsed = false, totalChunks = 0, expectedSha256 = "";

        pc.ondatachannel = (e) => {
          const dc = e.channel;
          // BUG-09 fix: ensure binary messages arrive as ArrayBuffer, not Blob
          dc.binaryType = "arraybuffer";
          setStatus("receiving");
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          dc.onmessage = (ev) => {
            if (!headerParsed) {
              // BUG-E fix: read expected sha256 from seeder header for integrity check
              const h = JSON.parse(ev.data as string) as { chunkCount: number; sha256?: string };
              totalChunks = h.chunkCount;
              expectedSha256 = h.sha256 ?? "";
              headerParsed = true;
              return;
            }
            if (ev.data === "__DONE__") {
              // BUG-E fix: verify SHA-256 of received data before triggering download
              const finalize = () => {
                if (expectedSha256) {
                  const sha = new SHA256Stream();
                  for (const chunk of receivedChunks) {
                    sha.update(new Uint8Array(chunk));
                  }
                  const actualHash = sha.digest();
                  if (actualHash !== expectedSha256) {
                    setStatus("error");
                    setErrorMsg("Bütünlük kontrolü başarısız — alınan veri bozulmuş veya değiştirilmiş olabilir.");
                    ws.close();
                    return;
                  }
                }
                const blob = new Blob(receivedChunks, { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a"); a.href = url; a.download = fileName;
                document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                setStatus("done"); setProgress(100); ws.close();
              };
              finalize();
              return;
            }
            receivedChunks.push(ev.data as ArrayBuffer);
            if (totalChunks > 0) setProgress(Math.round((receivedChunks.length / totalChunks) * 100));
          };
        };

        // BUG-01 fix: set remote first, then flush any queued ICE candidates
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
        remoteReadyRef.current = true;
        for (const c of pendingCandidatesRef.current) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* ignore */ }
        }
        pendingCandidatesRef.current = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", to: msg.from, sdp: pc.localDescription }));
      }

      if (msg.type === "ice") {
        // BUG-01 fix: queue if remote description isn't set yet; add immediately otherwise
        if (remoteReadyRef.current && pcRef.current) {
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit)); } catch { /* ignore */ }
        } else {
          pendingCandidatesRef.current.push(msg.candidate as RTCIceCandidateInit);
        }
      }
    };
    ws.onerror = () => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      setStatus("error");
      setErrorMsg("WebSocket bağlantısı başarısız.");
    };
  };

  return (
    <div className="space-y-4">
      {status === "idle" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 rounded-lg border border-primary/20 bg-primary/5">
            <Radio className="w-4 h-4 text-primary shrink-0" />
            <p className="text-xs text-muted-foreground font-mono">Bu dosya P2P olarak paylaşılıyor. İndirme doğrudan sahibin tarayıcısından akar.</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-mono">
            {presence === "checking" && <span className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Seeder durumu kontrol ediliyor…</span>}
            {presence === "online" && <span className="flex items-center gap-1.5 text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Seeder çevrimiçi</span>}
            {presence === "offline" && <span className="flex items-center gap-1.5 text-amber-400"><WifiOff className="w-3 h-3" /> Seeder çevrimdışı görünüyor</span>}
          </div>
          <Button className="w-full gap-2 text-xs font-mono" onClick={startDownload}>
            <Download className="w-3.5 h-3.5" /> P2P ile İndir
          </Button>
        </div>
      )}
      {status === "connecting" && (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-xs font-mono text-muted-foreground">Seeder'a bağlanılıyor…</p>
          {/* BUG-06 fix: cancel button so the UI never stays frozen */}
          <Button variant="ghost" size="sm" className="text-xs font-mono text-muted-foreground" onClick={cancelDownload}>
            İptal
          </Button>
        </div>
      )}
      {status === "receiving" && (
        <div className="space-y-3">
          <div className="flex justify-between text-xs font-mono text-muted-foreground">
            <span className="flex items-center gap-1"><Radio className="w-3.5 h-3.5 text-primary animate-pulse" /> Peer'dan alınıyor...</span>
            <span className="text-primary">{progress}%</span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>
      )}
      {status === "done" && (
        <div className="flex flex-col items-center gap-2 py-3">
          <Check className="w-8 h-8 text-emerald-400" />
          <p className="text-xs font-mono text-emerald-400">İndirme tamamlandı!</p>
          <Button variant="outline" size="sm" className="text-xs font-mono mt-1" onClick={() => setStatus("idle")}>Tekrar İndir</Button>
        </div>
      )}
      {(status === "offline" || status === "error") && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
            <WifiOff className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-xs text-red-400/80 font-mono">{errorMsg}</p>
          </div>
          <Button variant="outline" className="w-full gap-2 text-xs font-mono" onClick={startDownload}>Tekrar Dene</Button>
        </div>
      )}
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
          if (!meta.seedOnly && meta.isOwner) {
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

  const isSeedOnly = !!file.seedOnly;
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
              {isSeedOnly && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10px] font-mono shrink-0">
                  <Radio className="w-2.5 h-2.5" /> P2P Seed
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">{formatBytes(file.size)}</span>
              <span className="text-muted-foreground/30 text-xs">·</span>
              <span className="text-xs text-muted-foreground">{format(new Date(file.uploadedAt), "d MMM yyyy HH:mm", { locale: tr })}</span>
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
          {!isSeedOnly && (
            <Button variant="outline" size="sm" className="gap-2 text-xs font-mono" onClick={() => copy(directDownloadUrl, "directLink")}>
              {copiedDirectLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedDirectLink ? "Kopyalandı!" : "Direkt Link"}
            </Button>
          )}
          {!isSeedOnly && (
            <a href={downloadUrl} download={file.name}>
              <Button size="sm" variant="secondary" className="gap-2 text-xs font-mono">
                <Download className="w-3.5 h-3.5" /> İndir
              </Button>
            </a>
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
          {isSeedOnly ? (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 font-mono text-sm">
                  <Radio className="w-4 h-4 text-primary" /> P2P İndirme
                </CardTitle>
                <CardDescription className="text-xs">Bu dosya P2P olarak paylaşılıyor. WebRTC üzerinden doğrudan yükleyenin tarayıcısından akar.</CardDescription>
              </CardHeader>
              <CardContent>
                <P2PDownloader fileId={fileId} fileName={file.name} fileSize={file.size} mimeType={file.mimeType || "application/octet-stream"} />
              </CardContent>
            </Card>
          ) : (
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
          )}
        </div>

        <div className="space-y-5">
          <Card className="border-border/60 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <MetaRow label="Tür" value={isSeedOnly ? <span className="flex items-center gap-1 text-primary"><Radio className="w-3 h-3" /> P2P Seed</span> : "Sunucuda saklandı"} />
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

          {!isSeedOnly && (
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
          )}

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
    </div>
  );
}
