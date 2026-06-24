import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  UploadCloud, File, AlertCircle, Clock, Zap, Code2,
  Shield, X, GitBranch, Link2, Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";

import { hashFileStreaming } from "@/lib/sha256";
import { fetchWithRetry, FetchAbortedError } from "@/lib/fetchWithRetry";

const DEFAULT_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB fallback

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

type UploadStep =
  | { phase: "idle" }
  | { phase: "hashing"; done: number; total: number }
  | { phase: "uploading"; done: number; total: number }
  | { phase: "finalizing" };

interface UserStorageLimits {
  maxFileSizeBytes: number;
}

export default function UploadPage() {
  const [, setLocation] = useLocation();

  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadStep, setUploadStep] = useState<UploadStep>({ phase: "idle" });
  const [ttl, setTtl] = useState("");
  const [versionInput, setVersionInput] = useState("");
  const [parentFileId, setParentFileId] = useState<string | null>(null);
  const [parentFileName, setParentFileName] = useState<string | null>(null);
  const [versionLookupLoading, setVersionLookupLoading] = useState(false);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [userLimits, setUserLimits] = useState<UserStorageLimits>({ maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES });
  const [retryInfo, setRetryInfo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);
  // AbortController for in-flight fetch cancellation (network level)
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/folders", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<FolderMeta[]> : [])
      .then(setFolders)
      .catch(() => setFolders([]));
    fetch("/api/user/storage", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<UserStorageLimits> : null)
      .then((data) => { if (data?.maxFileSizeBytes) setUserLimits(data); })
      .catch(() => {});
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

  // resetState: hata sonrası temizlik için kullanılır.
  // abort bayrağını temizler çünkü bir sonraki yüklemede temiz başlamak gerekir.
  const resetState = () => {
    abortRef.current = false;
    controllerRef.current = null;
    setUploadStep({ phase: "idle" });
    setRetryInfo(null);
  };

  // cancelUpload: abort bayrağını ve AbortController'ı ateşler, UI'ı idle'a alır.
  // resetState() ÇAĞIRMAZ — resetState abort bayrağını temizler ve sinyal
  // upload loop'una ulaşamadan sıfırlanırdı.
  const cancelUpload = () => {
    abortRef.current = true;
    // Network düzeyinde in-flight fetch'i iptal et
    controllerRef.current?.abort();
    controllerRef.current = null;
    setUploadStep({ phase: "idle" });
    setRetryInfo(null);
    toast({ title: "Yükleme iptal edildi" });
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const validateAndSetFile = useCallback((f: File) => {
    if (f.size > userLimits.maxFileSizeBytes) {
      toast({
        variant: "destructive",
        title: "Dosya boyutu limitini geçiyor!",
        description: `Dosyanızın boyutu (${formatBytes(f.size)}) izin verilen maksimum sınırı (${formatBytes(userLimits.maxFileSizeBytes)}) aşıyor. Lütfen daha küçük bir dosya seçin.`,
      });
      return;
    }
    setFile(f);
  }, [userLimits]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) validateAndSetFile(e.dataTransfer.files[0]);
  }, [validateAndSetFile]);

  const isUploading = uploadStep.phase !== "idle";

  const handleUpload = async () => {
    if (!file) return;

    // Temiz başlangıç: abort bayrağını sıfırla, yeni AbortController oluştur.
    // AbortController → network düzeyinde in-flight fetch'i iptal eder (Ctrl+C gibi).
    // abortRef → bekleyen retry sleep'lerini ve hash progress callback'lerini durdurur.
    abortRef.current = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = controller.signal;

    // fetchWithRetry için ortak seçenekler
    const retryOpts = {
      maxAttempts: 4,        // 1 deneme + 3 retry
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      abortRef,
      onRetry: (attempt: number, maxRetries: number, delayMs: number, reason: string) => {
        const delaySec = Math.round(delayMs / 1_000);
        setRetryInfo(
          `Bağlantı hatası — yeniden deneniyor (${attempt}/${maxRetries}), ${delaySec}s… (${reason})`,
        );
      },
    };

    try {
      // ── Aşama 1: SHA-256 hash (streaming, 2 MB chunk'lar) ─────────────────────
      setUploadStep({ phase: "hashing", done: 0, total: file.size });
      const sha256 = await hashFileStreaming(
        file,
        2 * 1024 * 1024,
        (done, total) => {
          // Hash CPU-bound olduğu için durdurulamaz; abort sonrası UI güncellenmez.
          if (!abortRef.current) {
            setUploadStep({ phase: "hashing", done, total });
          }
        },
      );
      if (abortRef.current) return;

      // ── Aşama 2: Upload init ───────────────────────────────────────────────────
      const initRes = await fetchWithRetry(
        "/api/files/upload-init",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal,
          body: JSON.stringify({
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
          }),
        },
        retryOpts,
      );
      setRetryInfo(null);
      if (abortRef.current) return;
      if (!initRes.ok) throw new Error(await parseErrorMessage(initRes));
      const { uploadId, partSize: serverPartSize } = await initRes.json() as { uploadId: string; partSize?: number };

      // Sunucunun döndürdüğü partSize'ı kullan — Firebase per-user chunkSizeBytes.
      // Tutarsız değer gelirse 512 KB–100 MB arasına kısıtla.
      const PART_SIZE = (
        typeof serverPartSize === "number" &&
        Number.isInteger(serverPartSize) &&
        serverPartSize >= 512 * 1024 &&
        serverPartSize <= 100 * 1024 * 1024
      ) ? serverPartSize : 5 * 1024 * 1024;

      const totalParts = Math.ceil(file.size / PART_SIZE);
      let bytesDone = 0;
      setUploadStep({ phase: "uploading", done: 0, total: file.size });

      // ── Aşama 3: Part upload loop ──────────────────────────────────────────────
      for (let i = 0; i < totalParts; i++) {
        if (abortRef.current) return;

        const slice = file.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
        const fd = new FormData();
        fd.append("uploadId", uploadId);
        fd.append("partIndex", String(i));
        fd.append("part", slice, file.name);

        const partRes = await fetchWithRetry(
          "/api/files/upload-part",
          { method: "POST", credentials: "include", signal, body: fd },
          retryOpts,
        );
        // Part başarılı → retry bilgisini temizle
        setRetryInfo(null);
        if (abortRef.current) return;
        if (!partRes.ok) throw new Error(`Part ${i} başarısız: ${await parseErrorMessage(partRes)}`);

        bytesDone += slice.size;
        setUploadStep({ phase: "uploading", done: bytesDone, total: file.size });
      }

      if (abortRef.current) return;
      setUploadStep({ phase: "finalizing" });

      // ── Aşama 4: Finalize ──────────────────────────────────────────────────────
      const finalRes = await fetchWithRetry(
        "/api/files/upload-finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal,
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
        },
        retryOpts,
      );
      setRetryInfo(null);
      if (abortRef.current) return;
      if (!finalRes.ok) throw new Error(await parseErrorMessage(finalRes));

      const meta = await finalRes.json() as { id: string };
      toast({ title: "Yükleme tamamlandı ✓", description: "Dosya başarıyla bölündü ve saklandı." });
      setLocation(`/files/${meta.id}`);

    } catch (err) {
      // Kullanıcı iptali — sessizce çık, hata toast'u gösterme.
      // FetchAbortedError: abortRef retry sleep'inde ateşlendi.
      // DOMException AbortError: AbortController.abort() network fetch'i kesti.
      // abortRef.current: diğer abort kontrolleri.
      if (
        abortRef.current ||
        err instanceof FetchAbortedError ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      toast({
        variant: "destructive",
        title: "Yükleme başarısız",
        description: err instanceof Error ? err.message : "Bir hata oluştu",
      });
      resetState();
    }
  };

  // İlerleme çubuğu 3 aşamaya bölünmüş:
  //   Hash  : 0 % → 40 %  (CPU-bound, dosya boyutuna göre süre değişir)
  //   Upload: 40% → 95 %  (ağ hızına bağlı)
  //   Final : 97 %         (sunucu birleştirme + SHA-256 doğrulama)
  // retryInfo (bağlantı hatası / yeniden deneme mesajı) varsa her aşamada öncelikli göster.
  const progressLabel = (() => {
    if (retryInfo) return retryInfo;
    if (uploadStep.phase === "hashing") {
      const pct = uploadStep.total > 0 ? Math.round((uploadStep.done / uploadStep.total) * 100) : 0;
      return `Bütünlük doğrulanıyor… ${formatBytes(uploadStep.done)} / ${formatBytes(uploadStep.total)} (${pct}%)`;
    }
    if (uploadStep.phase === "uploading") return `Yükleniyor… ${formatBytes(uploadStep.done)} / ${formatBytes(uploadStep.total)}`;
    if (uploadStep.phase === "finalizing") return "Birleştiriliyor ve doğrulanıyor…";
    return "İşleniyor…";
  })();

  const progressValue = (() => {
    if (uploadStep.phase === "hashing")
      return (uploadStep.done / Math.max(1, uploadStep.total)) * 40;          // 0 → 40
    if (uploadStep.phase === "uploading")
      return 40 + (uploadStep.done / Math.max(1, uploadStep.total)) * 55;    // 40 → 95
    if (uploadStep.phase === "finalizing") return 97;
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
        <input type="file" ref={inputRef} className="hidden" onChange={(e) => { if (e.target.files?.[0]) validateAndSetFile(e.target.files[0]); e.target.value = ""; }} disabled={isUploading} />

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

                <Button className="w-full gap-2 font-mono text-sm" onClick={handleUpload}>
                  Yükle
                </Button>

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
        <span>Maks dosya boyutu: {formatBytes(userLimits.maxFileSizeBytes)} · Parça boyutu: 1 MB</span>
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
