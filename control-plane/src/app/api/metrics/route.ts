// BFF: Metrics proxy
// Fetches Prometheus metrics from T&T Engine and transforms to JSON for charts.
// Parses the Prometheus text format and extracts key metrics.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

interface ParsedMetric {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parsePrometheusLine(line: string): ParsedMetric | null {
  if (line.startsWith("#") || line.trim() === "") return null;

  // Match: metric_name{label="value",...} value
  const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?([^}]*)\}?\s+([\d.eE+-]+|NaN|Inf|-Inf)$/);
  if (!match) {
    // Simple metric without labels
    const simple = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+([\d.eE+-]+)$/);
    if (simple) return { name: simple[1], labels: {}, value: parseFloat(simple[2]) };
    return null;
  }

  const labels: Record<string, string> = {};
  if (match[2]) {
    match[2].split(",").forEach((pair) => {
      const [k, v] = pair.split("=");
      if (k && v) labels[k.trim()] = v.trim().replace(/"/g, "");
    });
  }

  return { name: match[1], labels, value: parseFloat(match[3]) };
}

export async function GET() {
  const now = new Date().toISOString();

  try {
    const res = await fetch(`${TNT_URL}/metrics`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();

    const metrics = text.split("\n").map(parsePrometheusLine).filter(Boolean) as ParsedMetric[];

    // Extract specific metrics for dashboard charts
    const cryptoLatency = metrics
      .filter((m) => m.name === "tnt_crypto_operation_duration_seconds_sum")
      .map((m) => ({ time: now, value: m.value }));

    const totalTokens = metrics.find((m) => m.name === "tnt_tokens_created_total");
    const errorTotal = metrics.filter((m) => m.name === "tnt_errors_total");

    return NextResponse.json({
      crypto_latency: cryptoLatency.length > 0 ? cryptoLatency : [{ time: now, value: 0 }],
      token_throughput: [{ time: now, value: totalTokens?.value ?? 0 }],
      error_rate: [{ time: now, value: errorTotal.reduce((s, m) => s + m.value, 0) }],
      cache_hit_rate: 0,
      total_tokens_created: totalTokens?.value ?? 0,
      active_connections: 0,
    });
  } catch {
    return NextResponse.json({
      crypto_latency: [],
      token_throughput: [],
      error_rate: [],
      cache_hit_rate: 0,
      total_tokens_created: 0,
      active_connections: 0,
    });
  }
}
