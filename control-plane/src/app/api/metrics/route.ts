// BFF: Metrics proxy — Prometheus text-format parser
// Fetches /metrics from T&T Engine, parses to JSON, accumulates time-series history.
//
// Fixed metrics (were hardcoded to 0):
//   - cache_hit_rate   → tnt_cache_hit_ratio gauge
//   - active_connections → tnt_db_pool_size{pool="write"} + {pool="read"} gauge
//
// SLO thresholds (from metrics.py):
//   - Crypto P99 latency : 200ms
//   - Error rate          : 1%
//   - Cache hit rate      : 80%

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

// ── SLO constants (mirror metrics.py) ─────────────────────────────
const SLO_LATENCY_P99_MS  = 200;
const SLO_CACHE_HIT_PCT   = 80;

// ── Time-series ring buffer ────────────────────────────────────────
// Module-level — persists across requests in the same server process.
// Accumulates one data point per polling cycle (default 15s client refresh).

const HISTORY_MAX = 20;

interface DataPoint {
  time: string;               // HH:MM:SS
  crypto_latency_ms: number;  // rolling avg ms per operation
  tokens_created: number;     // cumulative counter value
  errors: number;             // cumulative error count
  cache_hit_rate: number;     // 0–100 %
  db_connections: number;     // sum of DB pool gauges
  request_count: number;      // cumulative http requests
}

const history: DataPoint[] = [];

function pushPoint(point: DataPoint): void {
  history.push(point);
  if (history.length > HISTORY_MAX) history.shift();
}

// ── Prometheus text parser ─────────────────────────────────────────

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

      // metric{labels} value [timestamp]
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

      // metric value [timestamp]
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const value = parseFloat(parts[1]);
        if (!isNaN(value)) return { name: parts[0], labels: {}, value };
      }
      return null;
    })
    .filter((m): m is ParsedMetric => m !== null);
}

/** Sum all metric samples matching the given name (across labels). */
function sumMetric(metrics: ParsedMetric[], name: string): number {
  return metrics
    .filter((m) => m.name === name)
    .reduce((acc, m) => acc + m.value, 0);
}

/** Find first matching metric by name and optional label filter. */
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

// ── GET handler ────────────────────────────────────────────────────

export async function GET() {
  const now = new Date();
  const timeLabel = now.toLocaleTimeString("en-US", { hour12: false });

  try {
    const res = await fetch(`${TNT_URL}/metrics`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) throw new Error(`/metrics returned ${res.status}`);

    const text = await res.text();
    const metrics = parsePrometheusText(text);

    // ── Extract individual metrics ─────────────────────────────────

    // Crypto latency: compute rolling average (sum / count → avg seconds → ms)
    const cryptoSum   = sumMetric(metrics, "tnt_crypto_operation_duration_seconds_sum");
    const cryptoCount = sumMetric(metrics, "tnt_crypto_operation_duration_seconds_count");
    const cryptoAvgMs = cryptoCount > 0 ? (cryptoSum / cryptoCount) * 1_000 : 0;

    // Token throughput (cumulative counter)
    const totalTokens = findMetric(metrics, "tnt_tokens_created_total")?.value ?? 0;

    // Error total (sum across all error counters)
    const cryptoErrors = sumMetric(metrics, "tnt_crypto_errors_total");
    const dbErrors     = sumMetric(metrics, "tnt_db_errors_total");
    const httpErrors   = metrics
      .filter((m) => m.name === "tnt_http_requests_total" && m.labels.status?.startsWith("5"))
      .reduce((s, m) => s + m.value, 0);
    const totalErrors = cryptoErrors + dbErrors + httpErrors;

    // Cache hit rate — tnt_cache_hit_ratio is a gauge (0.0–1.0)
    const cacheHitRatio = findMetric(metrics, "tnt_cache_hit_ratio")?.value ?? 0;
    const cacheHitPct   = Math.round(cacheHitRatio * 100);

    // DB connections — sum of tnt_db_pool_size gauges
    const dbWritePool = findMetric(metrics, "tnt_db_pool_size", { pool: "write" })?.value ?? 0;
    const dbReadPool  = findMetric(metrics, "tnt_db_pool_size", { pool: "read" })?.value ?? 0;
    const dbConnTotal = dbWritePool + dbReadPool;

    // Request count
    const requestCount = sumMetric(metrics, "tnt_http_requests_total");

    // ── Accumulate history ─────────────────────────────────────────
    pushPoint({
      time:             timeLabel,
      crypto_latency_ms: Math.round(cryptoAvgMs * 10) / 10,
      tokens_created:   totalTokens,
      errors:           totalErrors,
      cache_hit_rate:   cacheHitPct,
      db_connections:   Math.round(dbConnTotal),
      request_count:    requestCount,
    });

    // ── Build response matching MetricsData type ──────────────────
    // Snapshots of history arrays (newest point last for recharts)
    const snap = [...history];

    return NextResponse.json({
      // Time-series arrays for recharts
      crypto_latency:  snap.map((p) => ({ time: p.time, value: p.crypto_latency_ms })),
      token_throughput: snap.map((p) => ({ time: p.time, value: p.tokens_created })),
      error_rate:       snap.map((p) => ({ time: p.time, value: p.errors })),
      db_connections_history: snap.map((p) => ({ time: p.time, value: p.db_connections })),

      // Point-in-time values
      cache_hit_rate:       cacheHitPct,
      total_tokens_created: totalTokens,
      active_connections:   Math.round(dbConnTotal),
      total_errors:         totalErrors,
      crypto_latency_avg_ms: Math.round(cryptoAvgMs * 10) / 10,

      // SLO breach flags for UI coloring
      slo: {
        latency_ok:   cryptoAvgMs < SLO_LATENCY_P99_MS,
        cache_ok:     cacheHitPct >= SLO_CACHE_HIT_PCT,
      },

      fetched_at: now.toISOString(),
    });
  } catch {
    // Return last known history with error flag
    const snap = [...history];
    return NextResponse.json({
      crypto_latency:           snap.map((p) => ({ time: p.time, value: p.crypto_latency_ms })),
      token_throughput:         snap.map((p) => ({ time: p.time, value: p.tokens_created })),
      error_rate:               snap.map((p) => ({ time: p.time, value: p.errors })),
      db_connections_history:   snap.map((p) => ({ time: p.time, value: p.db_connections })),
      cache_hit_rate:           0,
      total_tokens_created:     0,
      active_connections:       0,
      total_errors:             0,
      crypto_latency_avg_ms:    0,
      slo: { latency_ok: true, cache_ok: false },
      error: "Engine unreachable",
      fetched_at: now.toISOString(),
    });
  }
}
