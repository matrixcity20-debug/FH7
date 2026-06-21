import { useToast } from "@/hooks/use-toast";

export function Toaster() {
  const { toasts } = useToast();

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-xl border px-4 py-3 shadow-lg backdrop-blur-sm transition-all duration-300 ${
            t.variant === "destructive"
              ? "border-destructive/30 bg-destructive/10 text-destructive-foreground"
              : "border-border bg-card text-foreground"
          }`}
        >
          {t.title && <p className="text-sm font-semibold font-mono">{t.title}</p>}
          {t.description && <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>}
        </div>
      ))}
    </div>
  );
}
