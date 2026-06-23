import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  UploadCloud, File, AlertCircle, Clock, Zap, Code2,
  Shield, Radio, Server, Users, Wifi, WifiOff, X, GitBranch, Link2, Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";

import { hashFileStreaming } from "@/lib/sha256";

const TTL_OPTIONS = [
  { value: "", label: "Hiç dolmasın" },
  { value: "1h", label: "1 saat" },
  { value: "24h", label: "24 saat" },
  { value: "7d", label: "7 gün" },
  { value: "30d", label: "30 gün" },
];

const FEATURES = [
  { icon: Zap, title: "Anında bölme", desc: "Dosyalar otomatik olarak 1 MB parçalara bölünür" },
  { icon: Code2, title: "Sıfır bağımlılıklı embed", desc: "JS snippet'ini yapıştırarak indirme butonu ekleyin" },
  { icon: Shield, title: "Otomatik silme", desc: "TTL belirleyin, süresi dolan dosyalar silinir" },
];

const CHUNK_SIZE = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const json = await res.clone().json() as Record<string, unknown>;
    if (typeof json.error === "string") return json.error;
    if (typeof json.message === "string") return json.message;
  } catch { /* ignore */ }
  return res.statusText || "Bir hata oluştu";
}

interface FolderMeta {
  id: string;
  name: string;
  createdAt: string;
}

type SeedStatus = "idle" | "registering" | "seeding" | "offline";

interface SeederState {
  fileId: string;
  fileName: string;
  fileSize: number;
  chunkCount: number;
  connectedPeers: number;
  status: SeedStatus;
  bytesServed: number;
}

type UploadStep =
  | { phase: "idle" }
  | { phase: "hashing" }
  | { phase: "uploading"; done: number; total: number }
  | { phase: "finalizing" }
  | { phase: "chunking"; done: number; total: number }
  | { phase: "connecting" };

export default function UploadPage() {
  const [, setLocation] = useLocation();

  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadStep, setUploadStep] = useState<UploadStep>({ phase: "idle" });
  const [ttl, setTtl] = useState("");
  const [seederState, setSeederState] = useState<SeederState | null>(null);
  const [versionInput, setVersionInput] = useState("");
  const [parentFileId, setParentFileId] = useState<string | null>(null);
  const [parentFileName, setParentFileName] = useState<string | null>(null);
  const [versionLookupLoading, setVersionLookupLoading] = useState(false);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]); // kept for resetState cleanup compat
  // BUG-G fix: sha256 of the seeded file is computed once, included in every DC header
  const sha256Ref = useRef<string>("");
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const abortRef = useRef(false);
  // BUG-03 fix: central per-peer ICE queues and remote-ready flags (replaces per-peer addEventListener)
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const remoteSetRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    fetch("/api/folders", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<FolderMeta[]> : [])
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  const extractFileId = (input: string): string | null => {
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const m = input.match(uuidRe);
    return m ? m[0] : null;
  };

  const lookupParent = async (raw: string) => {
    const id = extractFileId(raw);
    if (!id) {
      toast({ variant: "destructive", title: "Geçersiz URL / ID" });
      return;
    }
    setVersionLookupLoading(true);
    try {
      const res = await fetch(`/api/files/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Dosya bulunamadı");
      const meta = await res.json() as { id: string; name: string };
      setParentFileId(meta.id);
      setParentFileName(meta.name);
    } catch {
      toast({ variant: "destructive", title: "Dosya bulunamadı", description: "URL'yi kontrol edip tekrar deneyin." });
      setParentFileId(null);
      setParentFileName(null);
    } finally {
      setVersionLookupLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("parentFileId");
    if (pid) void lookupParent(pid);
    const fid = params.get("folderId");
    if (fid) setSelectedFolderId(fid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      peersRef.current.forEach((pc) => pc.close());
    };
  }, []);

  const resetState = () => {
    wsRef.current?.close();
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    remoteSetRef.current.clear();
    chunksRef.current = [];
    abortRef.current = false;
    setUploadStep({ phase: "idle" });
  };

  const cancelUpload = () => {
    abortRef.current = true;
    resetState();
    toast({ title: "Yükleme iptal edildi" });
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) setFile(e.dataTransfer.files[0]);
  }, []);

  const isUploading = uploadStep.phase !== "idle";

  const handleUpload = async () => {
    if (!file) return;
    abortRef.current = false;
    const PART_SIZE = 5 * 1024 * 1024;

    try {
      setUploadStep({ phase: "hashing" });
      // BUG-08 fix: stream the file in 2 MB chunks — never loads the whole file
      const sha256 = await hashFileStreaming(file, 2 * 1024 * 1024);
      if (abortRef.current) return;

      const initRes = await fetch("/api/files/upload-init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type || "application/octet-stream" }),
      });
      if (abortRef.current) return;
      if (!initRes.ok) throw new Error(await parseErrorMessage(initRes));
      const { uploadId } = await initRes.json() as { uploadId: string };

      const totalParts = Math.ceil(file.size / PART_SIZE);
      let bytesDone = 0;
      setUploadStep({ phase: "uploading", done: 0, total: file.size });

      for (let i = 0; i < totalParts; i++) {
        if (abortRef.current) return;
        const slice = file.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
        const fd = new FormData();
        fd.append("uploadId", uploadId);
        fd.append("partIndex", String(i));
        fd.append("part", slice, file.name);

        const partRes = await fetch("/api/files/upload-part", { method: "POST", credentials: "include", body: fd });
        if (abortRef.current) return;
        if (!partRes.ok) throw new Error(`Part ${i} başarısız: ${await parseErrorMessage(partRes)}`);

        bytesDone += slice.size;
        setUploadStep({ phase: "uploading", done: bytesDone, total: file.size });
      }

      if (abortRef.current) return;
      setUploadStep({ phase: "finalizing" });

      const finalRes = await fetch("/api/files/upload-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          uploadId,
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          totalParts,
          sha256,
          ...(ttl ? { ttl } : {}),
          ...(parentFileId ? { parentFileId } : {}),
          ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        }),
      });
      if (abortRef.current) return;
      if (!finalRes.ok) throw new Error(await parseErrorMessage(finalRes));

      const meta = await finalRes.json() as { id: string };
      toast({ title: "Yükleme tamamlandı ✓", description: "Dosya başarıyla bölündü ve saklandı." });
      setLocation(`/files/${meta.id}`);

    } catch (err) {
      if (abortRef.current) return;
      toast({ variant: "destructive", title: "Yükleme başarısız", description: err instanceof Error ? err.message : "Bir hata oluştu" });
      resetState();
    }
  };

  const handleSeed = async () => {
    if (!file) return;
    abortRef.current = false;

    try {
      setUploadStep({ phase: "connecting" });
      const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

      const res = await fetch("/api/files/register-seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          chunkCount,
          ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        }),
      });

      if (!res.ok) throw new Error(await parseErrorMessage(res));
      if (abortRef.current) return;

      const meta = await res.json() as { id: string };
      const fileId = meta.id;

      // BUG-G fix: stream the file in CHUNK_SIZE slices to compute sha256 — no full-RAM load.
      // BUG-E fix: hash is stored and forwarded to leechers for integrity verification.
      setUploadStep({ phase: "chunking", done: 0, total: file.size });
      const fileSha256 = await hashFileStreaming(file, CHUNK_SIZE, (done) => {
        if (!abortRef.current) setUploadStep({ phase: "chunking", done, total: file.size });
      });
      if (abortRef.current) return;
      sha256Ref.current = fileSha256;

      setUploadStep({ phase: "connecting" });
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: "seed", fileId }));

      ws.onmessage = async (event) => {
        if (abortRef.current) return;
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;

        if (msg.type === "seeding") {
          setUploadStep({ phase: "idle" });
          setSeederState({ fileId, fileName: file.name, fileSize: file.size, chunkCount, connectedPeers: 0, status: "seeding", bytesServed: 0 });
          toast({ title: "Seeding aktif", description: "Linki paylaşın — kullanıcılar doğrudan tarayıcınızdan indirir." });
        }

        if (msg.type === "peer-joined") {
          const leecherId = msg.leecherId as string;
          const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
          peersRef.current.set(leecherId, pc);
          // BUG-03 fix: initialise per-peer state in the central maps
          pendingCandidatesRef.current.set(leecherId, []);
          remoteSetRef.current.set(leecherId, false);
          setSeederState((prev) => prev ? { ...prev, connectedPeers: prev.connectedPeers + 1 } : prev);

          const dc = pc.createDataChannel("file", { ordered: true });
          const BUFFER_HIGH = 4 * 1024 * 1024;
          const BUFFER_LOW = 1 * 1024 * 1024;
          dc.bufferedAmountLowThreshold = BUFFER_LOW;

          function waitForDrain(): Promise<void> {
            return new Promise((resolve) => {
              const prev = dc.onbufferedamountlow;
              dc.onbufferedamountlow = (e) => {
                dc.onbufferedamountlow = prev;
                resolve();
                if (typeof prev === "function") prev.call(dc, e);
              };
            });
          }

          dc.onopen = async () => {
            if (dc.readyState !== "open") return;
            // BUG-E fix: include sha256 so leecher can verify integrity
            // BUG-G fix: chunks are read on-demand here — never pre-loaded into chunksRef
            dc.send(JSON.stringify({ name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", chunkCount, sha256: sha256Ref.current }));
            for (let i = 0; i < chunkCount; i++) {
              if (dc.readyState !== "open") break;
              while (dc.bufferedAmount > BUFFER_HIGH) {
                if (dc.readyState !== "open") break;
                await waitForDrain();
              }
              if (dc.readyState !== "open") break;
              const chunk = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
              dc.send(chunk);
              setSeederState((prev) => prev ? { ...prev, bytesServed: prev.bytesServed + chunk.byteLength } : prev);
            }
            if (dc.readyState === "open") dc.send("__DONE__");
          };

          dc.onclose = () => {
            setSeederState((prev) => prev ? { ...prev, connectedPeers: Math.max(0, prev.connectedPeers - 1) } : prev);
            peersRef.current.delete(leecherId);
            pendingCandidatesRef.current.delete(leecherId);
            remoteSetRef.current.delete(leecherId);
            pc.close();
          };

          pc.onicecandidate = (e) => {
            if (e.candidate) ws.send(JSON.stringify({ type: "ice", to: leecherId, candidate: e.candidate }));
          };

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: "offer", to: leecherId, sdp: pc.localDescription }));
          // BUG-03 fix: answer/ice are handled below in the same onmessage — no per-peer addEventListener
        }

        // BUG-03 fix: central dispatch for answer and ice — one handler, no per-peer listener accumulation
        if (msg.type === "answer") {
          const from = msg.from as string;
          const pc = peersRef.current.get(from);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
            remoteSetRef.current.set(from, true);
            const pending = pendingCandidatesRef.current.get(from) ?? [];
            for (const c of pending) {
              try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* ignore */ }
            }
            pendingCandidatesRef.current.set(from, []);
          }
        }

        if (msg.type === "ice") {
          const from = msg.from as string;
          const pc = peersRef.current.get(from);
          if (pc) {
            if (remoteSetRef.current.get(from)) {
              try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit)); } catch { /* ignore */ }
            } else {
              const pending = pendingCandidatesRef.current.get(from) ?? [];
              pending.push(msg.candidate as RTCIceCandidateInit);
              pendingCandidatesRef.current.set(from, pending);
            }
          }
        }
      };

      ws.onerror = () => {
        if (!abortRef.current) {
          toast({ variant: "destructive", title: "WebSocket hatası", description: "Sinyal sunucusuna bağlanılamadı." });
          resetState();
        }
      };
      ws.onclose = () => setSeederState((prev) => prev ? { ...prev, status: "offline" } : prev);

    } catch (err) {
      if (abortRef.current) return;
      toast({ variant: "destructive", title: "Seed başarısız", description: err instanceof Error ? err.message : "Başlatılamadı" });
      resetState();
    }
  };

  const stopSeeding = () => {
    wsRef.current?.close();
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    remoteSetRef.current.clear();
    setSeederState(null);
    setFile(null);
    chunksRef.current = [];
    abortRef.current = false;
  };

  if (seederState) {
    // BUG-05 fix: corrected base path — /filesplit/files/ does not exist
    const shareUrl = `${window.location.origin}/files/${seederState.fileId}`;
    const isOnline = seederState.status === "seeding";

    return (
      <div className="max-w-2xl mx-auto space-y-6 mt-8">
        <div className="text-center space-y-2">
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-mono mb-2 ${isOnline ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
            {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {isOnline ? "Seeding aktif" : "Seeder çevrimdışı"}
          </div>
          <h1 className="text-3xl font-bold font-mono gradient-text">{seederState.fileName}</h1>
          <p className="text-muted-foreground text-sm">{formatBytes(seederState.fileSize)} · {seederState.chunkCount} parça</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border border-border/60 bg-card/60 text-center">
            <Users className="w-5 h-5 text-primary mx-auto mb-1" />
            <p className="text-2xl font-bold font-mono text-foreground">{seederState.connectedPeers}</p>
            <p className="text-xs text-muted-foreground">Aktif peer</p>
          </div>
          <div className="p-4 rounded-xl border border-border/60 bg-card/60 text-center">
            <Radio className="w-5 h-5 text-primary mx-auto mb-1" />
            <p className="text-2xl font-bold font-mono text-foreground">{formatBytes(seederState.bytesServed)}</p>
            <p className="text-xs text-muted-foreground">İletilen veri</p>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Paylaşım linki</p>
          <code className="text-xs font-mono text-primary break-all">{shareUrl}</code>
          <Button size="sm" className="w-full text-xs font-mono" onClick={() => navigator.clipboard.writeText(shareUrl).then(() => toast({ title: "Kopyalandı!" }))}>
            Linki Kopyala
          </Button>
        </div>

        <Button variant="destructive" className="w-full text-xs font-mono" onClick={stopSeeding}>
          Seeding'i Durdur
        </Button>
      </div>
    );
  }

  const progressLabel = (() => {
    if (uploadStep.phase === "hashing") return "Hash hesaplanıyor…";
    if (uploadStep.phase === "uploading") return `Yükleniyor… ${formatBytes(uploadStep.done)} / ${formatBytes(uploadStep.total)}`;
    if (uploadStep.phase === "finalizing") return "Birleştiriliyor ve doğrulanıyor…";
    if (uploadStep.phase === "chunking") return `Bölünüyor… ${uploadStep.done}/${uploadStep.total} parça`;
    if (uploadStep.phase === "connecting") return "Bağlanıyor…";
    return "İşleniyor…";
  })();

  const progressValue = (() => {
    if (uploadStep.phase === "hashing") return 2;
    if (uploadStep.phase === "uploading") return 5 + (uploadStep.done / Math.max(1, uploadStep.total)) * 88;
    if (uploadStep.phase === "finalizing") return 96;
    if (uploadStep.phase === "chunking") return (uploadStep.done / Math.max(1, uploadStep.total)) * 100;
    if (uploadStep.phase === "connecting") return 99;
    return 0;
  })();

  return (
    <div className="max-w-2xl mx-auto space-y-10 mt-8">
      <div className="space-y-4 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-mono mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          Hazır
        </div>
        <h1 className="text-5xl font-bold font-mono tracking-tight gradient-text leading-tight">
          Böl. Göm.<br />Dağıt.
        </h1>
        <p className="text-muted-foreground max-w-md mx-auto text-sm leading-relaxed">
          Herhangi bir dosyayı yükleyin — otomatik olarak parçalara bölünsün ve sıfır bağımlılıklı bir JS embed oluşturulsun.
        </p>
      </div>

      <div
        className={`relative rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden
          ${dragActive ? "border-primary/70 bg-primary/5 dropzone-active" : file ? "border-primary/30 bg-card cursor-default" : "border-border hover:border-primary/30 hover:bg-muted/20 bg-card cursor-pointer"}`}
        onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
        onClick={() => !isUploading && !file && inputRef.current?.click()}
      >
        <input type="file" ref={inputRef} className="hidden" onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }} disabled={isUploading} />

        <div className="p-14 text-center">
          {isUploading ? (
            <div className="space-y-6 max-w-sm mx-auto">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                <UploadCloud className="w-8 h-8 text-primary animate-pulse" />
              </div>
              <div className="space-y-3">
                <div className="flex justify-between text-sm font-mono text-muted-foreground">
                  <span>{progressLabel}</span>
                  <span className="text-primary">{Math.round(progressValue)}%</span>
                </div>
                <Progress value={progressValue} className="h-1.5" />
              </div>
              <Button variant="ghost" size="sm" className="text-xs font-mono gap-1.5" onClick={cancelUpload}>
                <X className="w-3.5 h-3.5" /> İptal
              </Button>
            </div>
          ) : file ? (
            <div className="space-y-5">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                <File className="w-8 h-8 text-primary" />
              </div>
              <div>
                <p className="font-mono text-base font-bold text-foreground">{file.name}</p>
                <p className="text-sm text-muted-foreground">{formatBytes(file.size)}</p>
              </div>

              <div className="flex flex-col items-center gap-4 w-full max-w-xs mx-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 bg-muted/50 border border-border rounded-lg px-3 py-2 w-full">
                  <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                  <select value={ttl} onChange={(e) => setTtl(e.target.value)} className="bg-transparent text-sm font-mono text-foreground focus:outline-none w-full">
                    {TTL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value} className="bg-card">{opt.label}</option>)}
                  </select>
                </div>

                {folders.length > 0 && (
                  <div className="flex items-center gap-2 bg-muted/50 border border-border rounded-lg px-3 py-2 w-full">
                    <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
                    <select value={selectedFolderId} onChange={(e) => setSelectedFolderId(e.target.value)} className="bg-transparent text-sm font-mono text-foreground focus:outline-none w-full">
                      <option value="" className="bg-card">Klasör yok (kök)</option>
                      {folders.map((f) => <option key={f.id} value={f.id} className="bg-card">{f.name}</option>)}
                    </select>
                  </div>
                )}

                <div className="w-full space-y-2">
                  <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                    <GitBranch className="w-3.5 h-3.5" />
                    <span>Mevcut bir dosyanın yeni versiyonu mu?</span>
                  </div>
                  {parentFileId ? (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
                      <Link2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="text-xs font-mono text-emerald-400 truncate flex-1">{parentFileName}</span>
                      <button onClick={() => { setParentFileId(null); setParentFileName(null); setVersionInput(""); }}>
                        <X className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input type="text" value={versionInput} onChange={(e) => setVersionInput(e.target.value)}
                        placeholder="Dosya URL veya ID yapıştırın…"
                        className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
                        onKeyDown={(e) => { if (e.key === "Enter" && versionInput) lookupParent(versionInput); }}
                      />
                      <Button size="sm" variant="outline" className="text-xs font-mono px-3" disabled={!versionInput || versionLookupLoading} onClick={() => lookupParent(versionInput)}>
                        {versionLookupLoading ? "…" : "Bağla"}
                      </Button>
                    </div>
                  )}
                </div>

                <p className="text-xs text-muted-foreground font-mono">Nasıl paylaşmak istersiniz?</p>

                <div className="grid grid-cols-2 gap-3 w-full">
                  <button onClick={handleUpload} className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-border hover:border-primary/40 bg-card hover:bg-primary/5 transition-all cursor-pointer">
                    <Server className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs font-mono font-semibold text-foreground">Sunucuda Sakla</span>
                    <span className="text-[10px] text-muted-foreground text-center">Her zaman erişilebilir</span>
                  </button>
                  <button onClick={handleSeed} className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-primary/40 bg-primary/5 hover:border-primary/70 hover:bg-primary/10 transition-all cursor-pointer">
                    <Radio className="w-5 h-5 text-primary" />
                    <span className="text-xs font-mono font-semibold text-primary">Tarayıcıdan Seed</span>
                    <span className="text-[10px] text-muted-foreground text-center">P2P — sekme açık kalmalı</span>
                  </button>
                </div>

                <Button variant="ghost" size="sm" onClick={() => { setFile(null); setParentFileId(null); setParentFileName(null); setVersionInput(""); }} className="font-mono text-xs text-muted-foreground">
                  Temizle
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-muted/50 border border-border flex items-center justify-center">
                <UploadCloud className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">Dosyayı buraya sürükleyin</p>
                <p className="text-sm text-muted-foreground">ya da tıklayarak bilgisayarınızdan seçin</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground justify-center font-mono">
        <AlertCircle className="w-3.5 h-3.5" />
        <span>Maks dosya boyutu: 500 MB · Parça boyutu: 1 MB</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {FEATURES.map(({ icon: Icon, title, desc }) => (
          <div key={title} className="p-4 rounded-xl border border-border/60 bg-card/60 space-y-2 hover:border-primary/20 hover:bg-card transition-all">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">{title}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
