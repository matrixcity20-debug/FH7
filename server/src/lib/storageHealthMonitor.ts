/**
 * Depolama Sağlık İzleyici — StorageHealthMonitor
 *
 * Yapılandırılmış tüm depolama sağlayıcılarını (R2, B2, e2) periyodik olarak test eder.
 * Durum geçişlerini (healthy → degraded, degraded → healthy) loglar.
 *
 * Güvenlik notları:
 *   - Kimlik bilgileri (access key, secret) hiçbir zaman dışarı verilmez.
 *   - Sadece durum, gecikme ve zaman damgası bilgisi sunulur.
 *   - Singleton pattern; tek bir zamanlayıcı çalışır (bellek sızıntısı yok).
 *   - HEALTH_CHECK_INTERVAL_MS env değişkeni ile interval ayarlanabilir (min: 30s).
 */

import { logger } from "./logger.js";
import {
  isR2Configured,
  listConfiguredBuckets as listR2Buckets,
  testR2Connectivity,
} from "./r2Storage.js";
import {
  isB2Configured,
  listConfiguredB2Buckets,
  testB2Connectivity,
} from "./b2Storage.js";
import {
  isE2Configured,
  listConfiguredE2Buckets,
  testE2Connectivity,
} from "./e2Storage.js";

// ── Tipler ────────────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "unknown";

export interface BucketHealthRecord {
  provider: "r2" | "b2" | "e2";
  bucket: string;
  status: HealthStatus;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  error: string | null;
}

export interface StorageHealthSnapshot {
  checkedAt: string | null;
  nextCheckAt: string | null;
  intervalMs: number;
  records: BucketHealthRecord[];
}

// ── Sabitler ─────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 30_000;          // 30 saniye minimum
const DEFAULT_INTERVAL_MS = 5 * 60_000; // 5 dakika varsayılan

// Ardışık kaç başarısızlıktan sonra "degraded" olarak işaretlenir
const DEGRADED_THRESHOLD = 1;

// ── Singleton ─────────────────────────────────────────────────────────────────

class StorageHealthMonitor {
  private records = new Map<string, BucketHealthRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number = DEFAULT_INTERVAL_MS;
  private lastCheckedAt: string | null = null;
  private nextCheckAt: string | null = null;
  private running = false;

  /** Monitörü başlatır. Sunucu ayağa kalktığında bir kez çağrılır. */
  start(intervalMs?: number): void {
    if (this.running) return;

    const raw = intervalMs ?? Number(process.env["HEALTH_CHECK_INTERVAL_MS"] ?? DEFAULT_INTERVAL_MS);
    this.intervalMs = Math.max(raw, MIN_INTERVAL_MS);
    this.running = true;

    logger.info({ intervalMs: this.intervalMs }, "StorageHealthMonitor: started");

    // İlk kontrolü hemen yap; sonrakiler interval ile
    void this.runChecks();
    this.timer = setInterval(() => {
      void this.runChecks();
    }, this.intervalMs);

    // Node.js'in bu timer nedeniyle kapanmasını engelleme
    this.timer.unref();
  }

  /** Monitörü durdurur (test / graceful shutdown için). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info("StorageHealthMonitor: stopped");
  }

  /** Anlık sağlık durumunu döndürür. Kimlik bilgisi içermez. */
  getSnapshot(): StorageHealthSnapshot {
    return {
      checkedAt: this.lastCheckedAt,
      nextCheckAt: this.nextCheckAt,
      intervalMs: this.intervalMs,
      records: Array.from(this.records.values()),
    };
  }

  // ── İç uygulama ─────────────────────────────────────────────────────────────

  private async runChecks(): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    if (isR2Configured()) {
      for (const bucket of listR2Buckets()) {
        tasks.push(this.checkBucket("r2", bucket, testR2Connectivity));
      }
    }

    if (isB2Configured()) {
      for (const bucket of listConfiguredB2Buckets()) {
        tasks.push(this.checkBucket("b2", bucket, testB2Connectivity));
      }
    }

    if (isE2Configured()) {
      for (const bucket of listConfiguredE2Buckets()) {
        tasks.push(this.checkBucket("e2", bucket, testE2Connectivity));
      }
    }

    if (tasks.length === 0) {
      logger.debug("StorageHealthMonitor: no configured providers — skipping check");
      return;
    }

    // Bir provider'ın hatası diğerlerini etkilemesin
    await Promise.allSettled(tasks);

    const now = new Date();
    this.lastCheckedAt = now.toISOString();
    this.nextCheckAt = new Date(now.getTime() + this.intervalMs).toISOString();

    const degraded = Array.from(this.records.values()).filter((r) => r.status === "degraded");
    if (degraded.length > 0) {
      logger.warn(
        { degraded: degraded.map((r) => `${r.provider}/${r.bucket}`) },
        "StorageHealthMonitor: degraded buckets detected",
      );
    }
  }

  private async checkBucket(
    provider: "r2" | "b2" | "e2",
    bucket: string,
    testFn: (bucket: string) => Promise<{ success: boolean; latencyMs: number; error?: string }>,
  ): Promise<void> {
    const key = `${provider}:${bucket}`;
    const prev = this.records.get(key);
    const now = new Date().toISOString();

    let result: { success: boolean; latencyMs: number; error?: string };
    try {
      result = await testFn(bucket);
    } catch (err) {
      result = {
        success: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : "Bilinmeyen hata",
      };
    }

    const consecutiveFailures = result.success
      ? 0
      : (prev?.consecutiveFailures ?? 0) + 1;

    const status: HealthStatus = result.success
      ? "healthy"
      : consecutiveFailures >= DEGRADED_THRESHOLD
      ? "degraded"
      : "unknown";

    // Durum geçişlerini logla
    const prevStatus = prev?.status ?? "unknown";
    if (prevStatus !== status) {
      if (status === "degraded") {
        logger.warn(
          { provider, bucket, error: result.error, consecutiveFailures },
          "StorageHealthMonitor: bucket degraded",
        );
      } else if (status === "healthy" && prevStatus === "degraded") {
        logger.info(
          { provider, bucket, latencyMs: result.latencyMs },
          "StorageHealthMonitor: bucket recovered",
        );
      }
    }

    this.records.set(key, {
      provider,
      bucket,
      status,
      latencyMs: result.success ? result.latencyMs : null,
      lastCheckedAt: now,
      lastSuccessAt: result.success ? now : (prev?.lastSuccessAt ?? null),
      lastFailureAt: result.success ? (prev?.lastFailureAt ?? null) : now,
      consecutiveFailures,
      error: result.success ? null : (result.error ?? "Bağlantı hatası"),
    });
  }
}

// ── Dışa açık singleton ──────────────────────────────────────────────────────
export const storageHealthMonitor = new StorageHealthMonitor();
