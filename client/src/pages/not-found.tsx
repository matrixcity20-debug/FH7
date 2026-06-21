import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="text-center py-24">
      <h2 className="text-xl font-mono font-bold mb-2 gradient-text">404 — Sayfa Bulunamadı</h2>
      <p className="text-muted-foreground text-sm mb-6">Aradığınız sayfa mevcut değil.</p>
      <Link href="/">
        <Button className="font-mono text-xs">Ana Sayfaya Dön</Button>
      </Link>
    </div>
  );
}
