import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  HardDrive, Trash2, ChevronRight, File, Clock, Plus,
  GitBranch, Folder, FolderOpen, FolderPlus, ArrowLeft, X,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { tr } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
  uploadedAt: string;
  expiresAt?: string;
  folderId?: string;
  version?: number;
  seedOnly?: boolean;
}

interface FolderMeta {
  id: string;
  name: string;
  createdAt: string;
}

export default function FileListPage() {
  const [, setLocation] = useLocation();

  const [files, setFiles] = useState<FileMeta[]>([]);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;

  const loadData = async () => {
    try {
      const [filesRes, foldersRes] = await Promise.all([
        fetch("/api/files", { credentials: "include" }),
        fetch("/api/folders", { credentials: "include" }),
      ]);
      if (filesRes.ok) setFiles(await filesRes.json() as FileMeta[]);
      if (foldersRes.ok) setFolders(await foldersRes.json() as FolderMeta[]);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const deleteFile = async (fileId: string, fileName: string) => {
    if (!confirm(`"${fileName}" silinsin mi?`)) return;
    try {
      const res = await fetch(`/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Silme başarısız");
      toast({ title: "Dosya silindi" });
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
    } catch {
      toast({ variant: "destructive", title: "Silme başarısız" });
    }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Klasör oluşturulamadı");
      }
      toast({ title: "Klasör oluşturuldu" });
      setNewFolderName("");
      setShowNewFolder(false);
      await loadData();
    } catch (err) {
      toast({ variant: "destructive", title: err instanceof Error ? err.message : "Klasör oluşturulamadı" });
    } finally {
      setCreatingFolder(false);
    }
  };

  const deleteFolder = async (folderId: string, folderName: string) => {
    if (!confirm(`"${folderName}" klasörü silinsin mi? İçindeki dosyalar köke taşınır.`)) return;
    try {
      const res = await fetch(`/api/folders/${folderId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Silme başarısız");
      toast({ title: "Klasör silindi", description: "Dosyalar köke taşındı." });
      if (currentFolderId === folderId) setCurrentFolderId(null);
      await loadData();
    } catch {
      toast({ variant: "destructive", title: "Klasör silinemedi" });
    }
  };

  const visibleFiles = files.filter((f) => {
    if (currentFolderId === null) return !f.folderId;
    return f.folderId === currentFolderId;
  });

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {currentFolderId && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setCurrentFolderId(null)}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
          )}
          <div className="space-y-0.5">
            <h1 className="text-2xl font-bold font-mono gradient-text">
              {currentFolder ? currentFolder.name : "Dosya Kütüphanesi"}
            </h1>
            <p className="text-muted-foreground text-sm">
              {currentFolder ? "Bu klasördeki dosyalar" : "Yüklediğiniz dosyalar ve klasörler."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!currentFolderId && (
            <Button variant="outline" size="sm" className="gap-2 text-xs font-mono" onClick={() => setShowNewFolder((v) => !v)}>
              <FolderPlus className="w-3.5 h-3.5" />
              Yeni Klasör
            </Button>
          )}
          <Link href={currentFolderId ? `/?folderId=${currentFolderId}` : "/"}>
            <Button className="gap-2 text-xs font-mono" size="sm">
              <Plus className="w-3.5 h-3.5" />
              Yeni Yükleme
            </Button>
          </Link>
        </div>
      </div>

      {showNewFolder && (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-primary/20 bg-primary/5">
          <Folder className="w-4 h-4 text-primary shrink-0" />
          <input
            type="text" autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createFolder(); if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); } }}
            placeholder="Klasör adı…"
            className="flex-1 bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <Button size="sm" className="text-xs font-mono px-3" disabled={!newFolderName.trim() || creatingFolder} onClick={createFolder}>
            {creatingFolder ? "…" : "Oluştur"}
          </Button>
          <Button size="sm" variant="ghost" className="text-xs text-muted-foreground px-2" onClick={() => { setShowNewFolder(false); setNewFolderName(""); }}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl border border-border bg-card/60 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {currentFolderId === null && folders.map((folder) => {
            const folderFileCount = files.filter((f) => f.folderId === folder.id).length;
            return (
              <div key={folder.id} className="group flex items-center justify-between p-4 rounded-xl border border-border/60 bg-card/60 hover:bg-card hover:border-primary/20 transition-all cursor-pointer" onClick={() => setCurrentFolderId(folder.id)}>
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <FolderOpen className="w-4.5 h-4.5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-foreground">{folder.name}</p>
                    <p className="text-xs text-muted-foreground">{folderFileCount} dosya</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); void deleteFolder(folder.id, folder.name); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>
            );
          })}

          {visibleFiles.length === 0 && (
            <div className="text-center py-16 border border-dashed border-border/40 rounded-xl">
              <HardDrive className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground font-mono">
                {currentFolderId ? "Bu klasörde dosya yok" : "Henüz dosya yüklemediniz"}
              </p>
              <Link href="/">
                <Button size="sm" variant="outline" className="mt-4 text-xs font-mono gap-2">
                  <Plus className="w-3.5 h-3.5" /> İlk Dosyayı Yükle
                </Button>
              </Link>
            </div>
          )}

          {visibleFiles.map((file) => {
            const isExpired = file.expiresAt ? new Date(file.expiresAt) < new Date() : false;
            return (
              <div
                key={file.id}
                className="group flex items-center justify-between p-4 rounded-xl border border-border/60 bg-card/60 hover:bg-card hover:border-primary/20 transition-all cursor-pointer"
                onClick={() => setLocation(`/files/${file.id}`)}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-muted/50 border border-border flex items-center justify-center shrink-0">
                    <File className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-mono text-sm font-medium text-foreground truncate max-w-xs">{file.name}</p>
                      {file.version !== undefined && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-primary/20 bg-primary/5 text-primary text-[10px] font-mono shrink-0">
                          <GitBranch className="w-2.5 h-2.5" /> v{file.version}
                        </span>
                      )}
                      {isExpired && <span className="text-[10px] font-mono text-destructive shrink-0">süresi doldu</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-muted-foreground font-mono">{formatBytes(file.size)}</span>
                      <span className="text-muted-foreground/30 text-xs">·</span>
                      <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(file.uploadedAt), { addSuffix: true, locale: tr })}</span>
                      {file.expiresAt && !isExpired && (
                        <>
                          <span className="text-muted-foreground/30 text-xs">·</span>
                          <span className="flex items-center gap-1 text-xs text-amber-400 font-mono">
                            <Clock className="w-3 h-3" />
                            {formatDistanceToNow(new Date(file.expiresAt), { addSuffix: true, locale: tr })} silinicek
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); void deleteFile(file.id, file.name); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
