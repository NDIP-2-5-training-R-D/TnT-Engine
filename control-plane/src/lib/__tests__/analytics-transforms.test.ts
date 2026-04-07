/**
 * Unit tests for analytics data transformation logic used in /api/analytics.
 * Tests groupByLabel, error calculation, and latency bucket processing.
 */

import { parsePrometheusText, sumMetric, groupByLabel, findMetric } from "../prometheus";

// Fixture: realistic Prometheus output from T&T Engine
const SAMPLE_PROMETHEUS = `
# HELP tnt_http_requests_total Total HTTP requests
# TYPE tnt_http_requests_total counter
tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="200"} 1000
tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="500"} 5
tnt_http_requests_total{method="POST",endpoint="/api/v1/detokenize",status="200"} 500
tnt_http_requests_total{method="GET",endpoint="/api/v1/health",status="200"} 200
# HELP tnt_crypto_errors_total Crypto errors
# TYPE tnt_crypto_errors_total counter
tnt_crypto_errors_total{operation="hmac"} 2
tnt_crypto_errors_total{operation="encrypt"} 1
# HELP tnt_db_errors_total DB errors
tnt_db_errors_total{operation="upsert"} 3
# HELP tnt_redis_errors_total Redis errors
tnt_redis_errors_total{operation="get"} 0
# HELP tnt_cache_hit_ratio Cache hit ratio
tnt_cache_hit_ratio 0.87
# HELP tnt_db_pool_size DB pool size
tnt_db_pool_size{pool="write"} 12
tnt_db_pool_size{pool="read"} 8
# HELP tnt_tokens_created_total Tokens created
tnt_tokens_created_total 1000
# HELP tnt_vault_health_sealed Vault sealed flag
tnt_vault_health_sealed 0
# HELP tnt_audit_buffer_size Audit buffer
tnt_audit_buffer_size 5
# HELP tnt_audit_dlq_file_size_bytes Audit DLQ size
tnt_audit_dlq_file_size_bytes 0
# HELP tnt_http_request_duration_seconds_bucket Latency histogram
tnt_http_request_duration_seconds_bucket{le="0.005"} 400
tnt_http_request_duration_seconds_bucket{le="0.01"} 700
tnt_http_request_duration_seconds_bucket{le="0.025"} 900
tnt_http_request_duration_seconds_bucket{le="0.05"} 1100
tnt_http_request_duration_seconds_bucket{le="+Inf"} 1200
# HELP tnt_crypto_operation_duration_seconds Crypto latency
tnt_crypto_operation_duration_seconds_count{operation="hmac"} 900
tnt_crypto_operation_duration_seconds_count{operation="encrypt"} 800
tnt_crypto_operation_duration_seconds_count{operation="decrypt"} 200
`;

describe("analytics request breakdown", () => {
  const metrics = parsePrometheusText(SAMPLE_PROMETHEUS);

  it("groups requests by endpoint correctly", () => {
    const byEndpoint = groupByLabel(metrics, "tnt_http_requests_total", "endpoint");
    expect(byEndpoint["/api/v1/tokenize"]).toBe(1005);
    expect(byEndpoint["/api/v1/detokenize"]).toBe(500);
    expect(byEndpoint["/api/v1/health"]).toBe(200);
  });

  it("identifies 5xx errors per endpoint", () => {
    const errors = metrics
      .filter((m) => m.name === "tnt_http_requests_total" && m.labels.status?.startsWith("5"))
      .reduce<Record<string, number>>((acc, m) => {
        const ep = m.labels.endpoint ?? "unknown";
        acc[ep] = (acc[ep] ?? 0) + m.value;
        return acc;
      }, {});
    expect(errors["/api/v1/tokenize"]).toBe(5);
    expect(errors["/api/v1/detokenize"]).toBeUndefined();
  });
});

describe("analytics error breakdown", () => {
  const metrics = parsePrometheusText(SAMPLE_PROMETHEUS);

  it("sums crypto errors correctly", () => {
    expect(sumMetric(metrics, "tnt_crypto_errors_total")).toBe(3);
  });

  it("sums db errors correctly", () => {
    expect(sumMetric(metrics, "tnt_db_errors_total")).toBe(3);
  });

  it("returns 0 for redis errors when all zero", () => {
    expect(sumMetric(metrics, "tnt_redis_errors_total")).toBe(0);
  });

  it("computes overall error rate", () => {
    const totalReqs   = sumMetric(metrics, "tnt_http_requests_total");
    const cryptoErr   = sumMetric(metrics, "tnt_crypto_errors_total");
    const dbErr       = sumMetric(metrics, "tnt_db_errors_total");
    const http5xx     = metrics
      .filter((m) => m.name === "tnt_http_requests_total" && m.labels.status?.startsWith("5"))
      .reduce((s, m) => s + m.value, 0);
    const totalErrors = cryptoErr + dbErr + http5xx;
    const errorRate   = totalReqs > 0 ? (totalErrors / totalReqs) * 100 : 0;
    expect(totalReqs).toBe(1705);
    expect(totalErrors).toBe(11);
    expect(errorRate).toBeCloseTo(0.645, 1);
  });
});

describe("analytics cache and DB metrics", () => {
  const metrics = parsePrometheusText(SAMPLE_PROMETHEUS);

  it("reads cache hit rate as percentage", () => {
    const ratio = findMetric(metrics, "tnt_cache_hit_ratio")?.value ?? 0;
    expect(Math.round(ratio * 100)).toBe(87);
  });

  it("sums DB pool connections", () => {
    const write = findMetric(metrics, "tnt_db_pool_size", { pool: "write" })?.value ?? 0;
    const read  = findMetric(metrics, "tnt_db_pool_size", { pool: "read"  })?.value ?? 0;
    expect(write + read).toBe(20);
  });

  it("reads vault sealed state", () => {
    const sealed = findMetric(metrics, "tnt_vault_health_sealed")?.value;
    expect(sealed).toBe(0); // 0 = not sealed = healthy
  });
});

describe("analytics latency bucket processing", () => {
  const metrics = parsePrometheusText(SAMPLE_PROMETHEUS);

  it("extracts latency buckets with cumulative to delta conversion", () => {
    const raw = metrics
      .filter((m) => m.name === "tnt_http_request_duration_seconds_bucket" && m.labels.le)
      .reduce<Record<string, number>>((acc, m) => {
        acc[m.labels.le] = (acc[m.labels.le] ?? 0) + m.value;
        return acc;
      }, {});

    const order = ["0.005","0.01","0.025","0.05","+Inf"];
    const buckets = order.map((b, i, arr) => {
      const current = raw[b] ?? 0;
      const prev    = i > 0 ? (raw[arr[i-1]] ?? 0) : 0;
      return { bucket: `≤${b}s`, count: Math.max(0, current - prev) };
    });

    // 0–5ms: 400 requests
    expect(buckets[0].count).toBe(400);
    // 5–10ms: 700-400=300
    expect(buckets[1].count).toBe(300);
    // 10–25ms: 900-700=200
    expect(buckets[2].count).toBe(200);
    // 25–50ms: 1100-900=200
    expect(buckets[3].count).toBe(200);
    // 50ms+: 1200-1100=100
    expect(buckets[4].count).toBe(100);
    // Total = 1200
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(1200);
  });
});

describe("analytics crypto operations", () => {
  const metrics = parsePrometheusText(SAMPLE_PROMETHEUS);

  it("groups crypto ops by operation type", () => {
    const byOp = groupByLabel(metrics, "tnt_crypto_operation_duration_seconds_count", "operation");
    expect(byOp["hmac"]).toBe(900);
    expect(byOp["encrypt"]).toBe(800);
    expect(byOp["decrypt"]).toBe(200);
  });

  it("sorts crypto ops by count descending", () => {
    const byOp = groupByLabel(metrics, "tnt_crypto_operation_duration_seconds_count", "operation");
    const sorted = Object.entries(byOp).sort(([,a],[,b]) => b - a);
    expect(sorted[0][0]).toBe("hmac");
    expect(sorted[0][1]).toBeGreaterThanOrEqual(sorted[1][1]);
  });
});
