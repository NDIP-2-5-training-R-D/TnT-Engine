// BFF: Alert Threshold Config API
//
// GET    — public (any auth): returns thresholds + live metric snapshot + computed alert level
// PUT    — admin/operator:    update a single threshold (warning, critical, enabled)
// DELETE — admin only:        reset all thresholds to factory defaults

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  getThresholds, updateThreshold, resetToDefaults,
  AlertThreshold, AlertLevel,
} from "@/lib/alert-store";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

// ── Types ──────────────────────────────────────────────────────────

export interface ThresholdWithStatus extends AlertThreshold {
  current_value: number | null;
  alert_level: AlertLevel;
}

interface MetricsSnapshot {
  error_rate_pct: number | null;
  crypto_latency_avg_ms: number | null;
  cache_hit_rate: number | null;
  audit_buffer_size: number | null;
  active_connections: number | null;
}

// ── Prometheus helpers (mirrors /api/metrics/route.ts) ─────────────

interface ParsedMetric {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parsePrometheusText(text: string): ParsedMetric[] {
  return text
    .split("\n")
    .map((line): ParsedMetric | null => {
      line = line.trim();
      if (!line || line.startsWith("#")) return null;

      const bracketIdx = line.indexOf("{");
      if (bracketIdx !== -1) {
        const closeBracket = line.indexOf("}");
        const name = line.slice(0, bracketIdx);
        const labelStr = line.slice(bracketIdx + 1, closeBracket);
        const rest = line.slice(closeBracket + 1).trim().split(/\s+/);
        const value = parseFloat(rest[0]);
        if (isNaN(value)) return null;

        const labels: Record<string, string> = {};
        labelStr.split(",").forEach((pair) => {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) return;
          const k = pair.slice(0, eqIdx).trim();
          const v = pair.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
          labels[k] = v;
        });
        return { name, labels, value };
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const value = parseFloat(parts[1]);
        if (!isNaN(value)) return { name: parts[0], labels: {}, value };
      }
      return null;
    })
    .filter((m): m is ParsedMetric => m !== null);
}

function sumMetric(metrics: ParsedMetric[], name: string): number {
  return metrics.filter((m) => m.name === name).reduce((a, m) => a + m.value, 0);
}

function findMetric(
  metrics: ParsedMetric[],
  name: string,
  labelFilter?: Record<string, string>,
): ParsedMetric | undefined {
  return metrics.find((m) => {
    if (m.name !== name) return false;
    if (!labelFilter) return true;
    return Object.entries(labelFilter).every(([k, v]) => m.labels[k] === v);
  });
}

async function fetchMetricsSnapshot(): Promise<MetricsSnapshot> {
  const empty: MetricsSnapshot = {
    error_rate_pct: null,
    crypto_latency_avg_ms: null,
    cache_hit_rate: null,
    audit_buffer_size: null,
    active_connections: null,
  };

  try {
    const res = await fetch(`${TNT_URL}/metrics`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return empty;

    const text = await res.text();
    const metrics = parsePrometheusText(text);

    // Error rate %
    const httpTotal  = sumMetric(metrics, "tnt_http_requests_total");
    const httpErrors = metrics
      .filter((m) => m.name === "tnt_http_requests_total" && m.labels.status?.startsWith("5"))
      .reduce((s, m) => s + m.value, 0);
    const errorRatePct = httpTotal > 0 ? (httpErrors / httpTotal) * 100 : 0;

    // Crypto P99 latency — using avg as proxy (engine may not expose histogram quantiles)
    const cryptoSum   = sumMetric(metrics, "tnt_crypto_operation_duration_seconds_sum");
    const cryptoCount = sumMetric(metrics, "tnt_crypto_operation_duration_seconds_count");
    const cryptoAvgMs = cryptoCount > 0 ? (cryptoSum / cryptoCount) * 1_000 : 0;

    // Cache hit rate (0–100)
    const cacheHitRatio = findMetric(metrics, "tnt_cache_hit_ratio")?.value ?? 0;
    const cacheHitPct   = Math.round(cacheHitRatio * 100);

    // Audit buffer size
    const auditBufferSize = findMetric(metrics, "tnt_audit_buffer_size")?.value ?? 0;

    // DB connections
    const dbWrite = findMetric(metrics, "tnt_db_pool_size", { pool: "write" })?.value ?? 0;
    const dbRead  = findMetric(metrics, "tnt_db_pool_size", { pool: "read"  })?.value ?? 0;
    const dbTotal = dbWrite + dbRead;

    return {
      error_rate_pct:        Math.round(errorRatePct * 100) / 100,
      crypto_latency_avg_ms: Math.round(cryptoAvgMs * 10) / 10,
      cache_hit_rate:        cacheHitPct,
      audit_buffer_size:     Math.round(auditBufferSize),
      active_connections:    Math.round(dbTotal),
    };
  } catch {
    return empty;
  }
}

// ── Alert level computation ────────────────────────────────────────

function computeAlertLevel(
  threshold: AlertThreshold,
  current: number | null,
): AlertLevel {
  if (!threshold.enabled || current === null) return "ok";

  const { warning, critical, direction } = threshold;

  if (direction === "above") {
    if (current >= critical) return "critical";
    if (current >= warning)  return "warning";
    return "ok";
  } else {
    // "below" — fire when value drops under threshold
    if (current <= critical) return "critical";
    if (current <= warning)  return "warning";
    return "ok";
  }
}

// ── GET ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const [thresholds, snapshot] = await Promise.all([
    Promise.resolve(getThresholds()),
    fetchMetricsSnapshot(),
  ]);

  const result: ThresholdWithStatus[] = thresholds.map((t) => {
    const current = (snapshot[t.metric_key as keyof MetricsSnapshot]) ?? null;
    return {
      ...t,
      current_value: current,
      alert_level: computeAlertLevel(t, current),
    };
  });

  const summary = {
    ok:       result.filter((t) => t.alert_level === "ok").length,
    warning:  result.filter((t) => t.alert_level === "warning").length,
    critical: result.filter((t) => t.alert_level === "critical").length,
  };

  return NextResponse.json({
    thresholds: result,
    summary,
    fetched_at: new Date().toISOString(),
  });
}

// ── PUT ────────────────────────────────────────────────────────────

export async function PUT(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "manager"]);
  if (auth.error) return auth.error;

  let body: { id: string; warning?: number; critical?: number; enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: "Missing required field: id" }, { status: 400 });
  }

  const patch: Partial<Pick<typeof body, "warning" | "critical" | "enabled">> = {};
  if (body.warning  !== undefined) patch.warning  = Number(body.warning);
  if (body.critical !== undefined) patch.critical = Number(body.critical);
  if (body.enabled  !== undefined) patch.enabled  = Boolean(body.enabled);

  const updated = updateThreshold(body.id, patch);
  if (!updated) {
    return NextResponse.json({ error: `Threshold '${body.id}' not found` }, { status: 404 });
  }

  return NextResponse.json({ success: true, threshold: updated });
}

// ── DELETE ─────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  const thresholds = resetToDefaults();
  return NextResponse.json({ success: true, thresholds, reset_at: new Date().toISOString() });
}
