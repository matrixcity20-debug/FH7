import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import {
  Copy, Download, Trash2, Terminal, ArrowLeft, Layers,
  FileCode2, Check, Link2, Clock, Radio, WifiOff, Loader2, GitBranch, Plus,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { tr } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { Link } from "wouter";

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

function P2PDownloader({ fileId, fileName, fileSize, mimeType }: { fileId: string; fileName: string; fileSize: number; mimeType: string }) {
  const [status, setStatus] = useState<P2PStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [presence, setPresence] = useState<SeederPresence>("checking");
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

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
    return () => { wsRef.current?.close(); pcRef.current?.close(); };
  }, []);

  const startDownload = () => {
    setStatus("connecting"); setProgress(0); setErrorMsg("");
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "leech", fileId }));
    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      if (msg.type === "seeder-offline") { setStatus("offline"); setErrorMsg("Seeder çevrimdışı. Dosya sahibinin tarayıcısı açık değil."); ws.close(); return; }
      if (msg.type === "offer") {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        pcRef.current = pc;
        pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: "ice", to: msg.from, candidate: e.candidate })); };
        const receivedChunks: ArrayBuffer[] = [];
        let headerParsed = false, totalChunks = 0;
        pc.ondatachannel = (e) => {
          const dc = e.channel;
          setStatus("receiving");
          dc.onmessage = (ev) => {
            if (!headerParsed) { const h = JSON.parse(ev.data as string) as { chunkCount: number }; totalChunks = h.chunkCount; headerParsed = true; return; }
            if (ev.data === "__DONE__") {
              const blob = new Blob(receivedChunks, { type: mimeType });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = fileName;
              document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
              setStatus("done"); setProgress(100); ws.close(); return;
            }
            receivedChunks.push(ev.data as ArrayBuffer);
            if (totalChunks > 0) setProgress(Math.round((receivedChunks.length / totalChunks) * 100));
          };
        };
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", to: msg.from, sdp: pc.localDescription }));
      }
      if (msg.type === "ice" && pcRef.current) {
        try { await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit)); } catch { /* ignore */ }
      }
    };
    ws.onerror = () => { setStatus("error"); setErrorMsg("WebSocket bağlantısı başarısız."); };
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
          <p className="text-xs font-mono text-muted-foreground">Seeder'a bağlanılıyor...</p>
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
  const [file, setFile] = useState<FileMeta | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (!fileId) return;
    Promise.all([
      fetch(`/api/files/${fileId}`, { credentials: "include" }).then((r) => r.ok ? r.json() : null),
    ]).then(([meta]) => {
      setFile(meta as FileMeta | null);
      if (meta && !(meta as FileMeta).seedOnly) {
        fetch(`/api/files/${fileId}/snippet`, { credentials: "include" })
          .then((r) => r.ok ? r.json() : null)
          .then((d) => setSnippet((d as { snippet?: string } | null)?.snippet ?? null))
          .catch(() => {});
      }
    }).catch(() => setFile(null)).finally(() => setLoading(false));
  }, [fileId]);

  const deleteFile = async () => {
    if (!file || !confirm(`"${file.name}" silinsin mi?`)) return;
    const res = await fetch(`/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
    if (res.ok) { toast({ title: "Dosya silindi" }); setLocation("/files"); }
    else toast({ variant: "destructive", title: "Silme başarısız" });
  };

  const copy = async (text: string, type: "snippet" | "link") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "snippet") { setCopiedSnippet(true); setTimeout(() => setCopiedSnippet(false), 2000); }
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

  if (!file) {
    return (
      <div className="text-center py-24">
        <FileCode2 className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
        <h2 className="text-xl font-mono font-bold mb-2">Dosya bulunamadı</h2>
        <p className="text-muted-foreground text-sm mb-6">Bu dosya mevcut değil, silinmiş ya da size ait değil.</p>
        <Link href="/files"><Button className="font-mono text-xs">Kütüphaneye Dön</Button></Link>
      </div>
    );
  }

  const isSeedOnly = !!file.seedOnly;
  const downloadUrl = `/api/files/${fileId}/download`;
  const shareUrl = `${window.location.origin}/filesplit/files/${fileId}`;
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
            {copiedLink ? "Kopyalandı!" : "Linki Kopyala"}
          </Button>
          {!isSeedOnly && (
            <a href={downloadUrl} download={file.name}>
              <Button size="sm" variant="secondary" className="gap-2 text-xs font-mono">
                <Download className="w-3.5 h-3.5" /> İndir
              </Button>
            </a>
          )}
          <Button size="sm" variant="destructive" className="gap-2 text-xs font-mono" onClick={deleteFile}>
            <Trash2 className="w-3.5 h-3.5" /> Sil
          </Button>
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
              {snippet && (
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

          {file.groupId && <VersionHistory groupId={file.groupId} currentFileId={fileId} />}

          <Card className="border-border/60 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm flex items-center gap-2">
                <Link2 className="w-3.5 h-3.5 text-primary" /> Paylaşım Linki
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                <code className="text-xs font-mono text-muted-foreground break-all leading-relaxed">{shareUrl}</code>
              </div>
              <Button className="w-full gap-2 text-xs font-mono" onClick={() => copy(shareUrl, "link")}>
                {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedLink ? "Kopyalandı!" : "Linki Kopyala"}
              </Button>
              {!isSeedOnly && (
                <a href={downloadUrl} download={file.name} className="block">
                  <Button variant="outline" className="w-full gap-2 text-xs font-mono">
                    <Download className="w-3.5 h-3.5" /> Dosyayı İndir
                  </Button>
                </a>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
