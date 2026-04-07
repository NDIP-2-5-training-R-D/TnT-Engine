import { parsePrometheusText, sumMetric, findMetric, groupByLabel } from "../prometheus";

// ── parsePrometheusText ────────────────────────────────────────────

describe("parsePrometheusText", () => {
  it("ignores comment and blank lines", () => {
    const input = `# HELP tnt_tokens_created_total Total tokens
# TYPE tnt_tokens_created_total counter

`;
    expect(parsePrometheusText(input)).toEqual([]);
  });

  it("parses a simple metric without labels", () => {
    const input = "tnt_tokens_created_total 42\n";
    const result = parsePrometheusText(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "tnt_tokens_created_total", labels: {}, value: 42 });
  });

  it("parses a metric with single label", () => {
    const input = `tnt_http_requests_total{status="200"} 100\n`;
    const result = parsePrometheusText(input);
    expect(result[0].name).toBe("tnt_http_requests_total");
    expect(result[0].labels).toEqual({ status: "200" });
    expect(result[0].value).toBe(100);
  });

  it("parses a metric with multiple labels", () => {
    const input = `tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="200"} 55\n`;
    const [m] = parsePrometheusText(input);
    expect(m.labels).toEqual({ method: "POST", endpoint: "/api/v1/tokenize", status: "200" });
    expect(m.value).toBe(55);
  });

  it("handles NaN values by excluding them", () => {
    const input = "tnt_some_metric NaN\n";
    expect(parsePrometheusText(input)).toHaveLength(0);
  });

  it("parses floating-point values correctly", () => {
    const input = "tnt_cache_hit_ratio 0.875\n";
    const [m] = parsePrometheusText(input);
    expect(m.value).toBeCloseTo(0.875);
  });

  it("parses scientific notation", () => {
    const input = "tnt_latency_sum 1.5e-3\n";
    const [m] = parsePrometheusText(input);
    expect(m.value).toBeCloseTo(0.0015);
  });

  it("parses a realistic Prometheus text block", () => {
    const input = `# HELP tnt_http_requests_total Total HTTP requests
# TYPE tnt_http_requests_total counter
tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="200"} 1234
tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="500"} 3
tnt_http_requests_total{method="POST",endpoint="/api/v1/detokenize",status="200"} 789
tnt_cache_hit_ratio 0.92
tnt_db_pool_size{pool="write"} 10
tnt_db_pool_size{pool="read"} 5
`;
    const metrics = parsePrometheusText(input);
    expect(metrics).toHaveLength(6);
  });
});

// ── sumMetric ──────────────────────────────────────────────────────

describe("sumMetric", () => {
  const metrics = parsePrometheusText(`
tnt_crypto_errors_total{operation="hmac"} 2
tnt_crypto_errors_total{operation="encrypt"} 5
tnt_crypto_errors_total{operation="decrypt"} 1
tnt_db_errors_total{operation="upsert"} 3
`);

  it("sums all samples of a metric across labels", () => {
    expect(sumMetric(metrics, "tnt_crypto_errors_total")).toBe(8);
  });

  it("returns 0 for unknown metric name", () => {
    expect(sumMetric(metrics, "tnt_nonexistent_metric")).toBe(0);
  });

  it("does not cross-contaminate between metric names", () => {
    expect(sumMetric(metrics, "tnt_db_errors_total")).toBe(3);
  });
});

// ── findMetric ─────────────────────────────────────────────────────

describe("findMetric", () => {
  const metrics = parsePrometheusText(`
tnt_db_pool_size{pool="write"} 10
tnt_db_pool_size{pool="read"} 5
tnt_cache_hit_ratio 0.85
`);

  it("finds by name only (first match)", () => {
    const m = findMetric(metrics, "tnt_db_pool_size");
    expect(m).toBeDefined();
    expect(m!.value).toBe(10);
  });

  it("finds by name and label filter", () => {
    const m = findMetric(metrics, "tnt_db_pool_size", { pool: "read" });
    expect(m!.value).toBe(5);
  });

  it("returns undefined for non-matching label", () => {
    const m = findMetric(metrics, "tnt_db_pool_size", { pool: "replica" });
    expect(m).toBeUndefined();
  });

  it("finds metric without labels", () => {
    const m = findMetric(metrics, "tnt_cache_hit_ratio");
    expect(m!.value).toBeCloseTo(0.85);
  });
});

// ── groupByLabel ───────────────────────────────────────────────────

describe("groupByLabel", () => {
  const metrics = parsePrometheusText(`
tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="200"} 100
tnt_http_requests_total{method="GET",endpoint="/api/v1/health",status="200"} 50
tnt_http_requests_total{method="POST",endpoint="/api/v1/tokenize",status="500"} 3
tnt_http_requests_total{method="POST",endpoint="/api/v1/detokenize",status="200"} 75
`);

  it("groups by endpoint correctly", () => {
    const groups = groupByLabel(metrics, "tnt_http_requests_total", "endpoint");
    expect(groups["/api/v1/tokenize"]).toBe(103);
    expect(groups["/api/v1/health"]).toBe(50);
    expect(groups["/api/v1/detokenize"]).toBe(75);
  });

  it("groups by method", () => {
    const groups = groupByLabel(metrics, "tnt_http_requests_total", "method");
    expect(groups["POST"]).toBe(178);
    expect(groups["GET"]).toBe(50);
  });

  it("returns empty object for unknown metric", () => {
    const groups = groupByLabel(metrics, "tnt_unknown", "method");
    expect(Object.keys(groups)).toHaveLength(0);
  });

  it("uses 'unknown' key for missing label", () => {
    const custom = parsePrometheusText(`tnt_foo{x="1"} 5\ntnt_foo 10\n`);
    const groups = groupByLabel(custom, "tnt_foo", "x");
    expect(groups["1"]).toBe(5);
    expect(groups["unknown"]).toBe(10);
  });
});
