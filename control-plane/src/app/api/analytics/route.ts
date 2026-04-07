// BFF: Analytics data endpoint
// Fetches /metrics from T&T Engine and reshapes Prometheus data into
// chart-friendly structures for the /analytics page.
//
// Returns:
//   - requestBreakdown:  [{ name: endpoint, total, errors }]  ← BarChart
//   - errorBreakdown:    [{ name: source, value }]            ← PieChart
//   - transformBreakdown:[{ name: op, value }]                ← PieChart
//   - latencyBuckets:    [{ bucket, count }]                  ← BarChart
//   - cryptoOps:         [{ operation, count }]               ← BarChart
//   - summary: { totalRequests, errorRate, cacheHitRate, vaultSealed }

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { parsePrometheusText, sumMetric, groupByLabel, findMetric } from "@/lib/prometheus";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

export async function GET() {
  try {
    const res = await fetch(`${TNT_URL}/metrics`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`/metrics returned ${res.status}`);
    const text = await res.text();
    const metrics = parsePrometheusText(text);

    // ── Request breakdown by endpoint ─────────────────────────────
    const reqByEndpoint = groupByLabel(metrics, "tnt_http_requests_total", "endpoint");
    const errByEndpoint = metrics
      .filter((m) => m.name === "tnt_http_requests_total" && m.labels.status?.startsWith("5"))
      .reduce<Record<string, number>>((acc, m) => {
        const ep = m.labels.endpoint ?? "unknown";
        acc[ep] = (acc[ep] ?? 0) + m.value;
        return acc;
      }, {});

    const requestBreakdown = Object.entries(reqByEndpoint)
      .map(([name, total]) => ({ name: name.replace("/api/v1/", ""), total, errors: errByEndpoint[name] ?? 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    // ── Error breakdown by source ──────────────────────────────────
    const cryptoErrors = sumMetric(metrics, "tnt_crypto_errors_total");
    const dbErrors     = sumMetric(metrics, "tnt_db_errors_total");
    const redisErrors  = sumMetric(metrics, "tnt_redis_errors_total");
    const httpErrors   = metrics
      .filter((m) => m.name === "tnt_http_requests_total" && m.labels.status?.startsWith("5"))
      .reduce((s, m) => s + m.value, 0);

    const errorBreakdown = [
      { name: "Crypto",   value: cryptoErrors },
      { name: "Database", value: dbErrors     },
      { name: "Redis",    value: redisErrors  },
      { name: "HTTP 5xx", value: httpErrors   },
    ].filter((e) => e.value > 0);

    // ── Token operation breakdown ──────────────────────────────────
    const tokenByOp = groupByLabel(metrics, "tnt_token_operations_total", "operation");
    const totalTokenize = findMetric(metrics, "tnt_tokens_created_total")?.value ?? 0;
    const transformBreakdown = [
      { name: "TOKENIZE",  value: totalTokenize },
      ...Object.entries(tokenByOp).map(([name, value]) => ({ name, value })),
    ].filter((e) => e.value > 0);

    // ── HTTP request latency buckets ────────────────────────────────
    const latencyBuckets = metrics
      .filter((m) => m.name === "tnt_http_request_duration_seconds_bucket" && m.labels.le)
      .reduce<Record<string, number>>((acc, m) => {
        const le = m.labels.le;
        acc[le] = (acc[le] ?? 0) + m.value;
        return acc;
      }, {});

    const bucketOrder = ["0.005","0.01","0.025","0.05","0.1","0.2","0.5","1.0","2.5","+Inf"];
    const latencyData = bucketOrder
      .filter((b) => latencyBuckets[b] !== undefined)
      .map((b, i, arr) => {
        const current = latencyBuckets[b] ?? 0;
        const prev    = i > 0 ? (latencyBuckets[arr[i - 1]] ?? 0) : 0;
        return { bucket: `≤${b}s`, count: Math.max(0, current - prev) };
      })
      .filter((b) => b.count > 0);

    // ── Crypto operations breakdown ────────────────────────────────
    const cryptoByOp = groupByLabel(metrics, "tnt_crypto_operation_duration_seconds_count", "operation");
    const cryptoOps = Object.entries(cryptoByOp)
      .map(([operation, count]) => ({ operation, count }))
      .sort((a, b) => b.count - a.count);

    // ── Summary ────────────────────────────────────────────────────
    const totalReqs   = sumMetric(metrics, "tnt_http_requests_total");
    const totalErrors = cryptoErrors + dbErrors + redisErrors + httpErrors;
    const cacheHit    = findMetric(metrics, "tnt_cache_hit_ratio")?.value ?? 0;
    const vaultSealed = findMetric(metrics, "tnt_vault_health_sealed")?.value === 1;
    const auditBuf    = findMetric(metrics, "tnt_audit_buffer_size")?.value ?? 0;
    const auditDlq    = findMetric(metrics, "tnt_audit_dlq_file_size_bytes")?.value ?? 0;

    return NextResponse.json({
      requestBreakdown,
      errorBreakdown,
      transformBreakdown,
      latencyBuckets: latencyData,
      cryptoOps,
      summary: {
        totalRequests:   totalReqs,
        totalErrors,
        errorRate:       totalReqs > 0 ? ((totalErrors / totalReqs) * 100).toFixed(2) : "0.00",
        cacheHitPct:     Math.round(cacheHit * 100),
        vaultSealed,
        auditBufferSize: auditBuf,
        auditDlqBytes:   auditDlq,
        totalTokensCreated: totalTokenize,
      },
      fetched_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Engine unreachable: ${msg}` }, { status: 503 });
  }
}
