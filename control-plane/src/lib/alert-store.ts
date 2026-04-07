/**
 * Alert threshold store — persists alert configurations to disk.
 *
 * Stores 5 default thresholds covering key T&T Engine health signals:
 *   - Error rate, P99 latency, cache hit rate, audit buffer, DB connections
 *
 * File location: /tmp/tnt-alert-config.json
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

export type AlertLevel = "ok" | "warning" | "critical";
export type AlertDirection = "above" | "below";

export interface AlertThreshold {
  id: string;
  name: string;
  description: string;
  metric_key: string;
  warning: number;
  critical: number;
  unit: string;
  direction: AlertDirection;
  enabled: boolean;
}

export interface AlertState {
  thresholds: AlertThreshold[];
  updated_at: string;
}

const STORE_PATH = process.env.ALERT_STORE_PATH || "/tmp/tnt-alert-config.json";

const DEFAULT_THRESHOLDS: AlertThreshold[] = [
  {
    id: "error_rate_pct",
    name: "Error Rate",
    description: "HTTP 5xx error rate percentage",
    metric_key: "error_rate_pct",
    warning: 1,
    critical: 5,
    unit: "%",
    direction: "above",
    enabled: true,
  },
  {
    id: "latency_p99_ms",
    name: "P99 Latency",
    description: "Crypto operation P99 latency",
    metric_key: "crypto_latency_avg_ms",
    warning: 100,
    critical: 500,
    unit: "ms",
    direction: "above",
    enabled: true,
  },
  {
    id: "cache_hit_pct",
    name: "Cache Hit Rate",
    description: "Token cache hit percentage",
    metric_key: "cache_hit_rate",
    warning: 70,
    critical: 50,
    unit: "%",
    direction: "below",
    enabled: true,
  },
  {
    id: "audit_buffer_size",
    name: "Audit Buffer",
    description: "Pending audit entries in memory buffer",
    metric_key: "audit_buffer_size",
    warning: 50,
    critical: 200,
    unit: "",
    direction: "above",
    enabled: true,
  },
  {
    id: "db_connections",
    name: "DB Connections",
    description: "Active database pool connections",
    metric_key: "active_connections",
    warning: 15,
    critical: 19,
    unit: "",
    direction: "above",
    enabled: true,
  },
];

// ── Store I/O ──────────────────────────────────────────────────────

function loadStore(): AlertState {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as AlertState;
      // Merge: ensure any new defaults are present even if store predates them
      const existingIds = new Set(raw.thresholds.map((t) => t.id));
      for (const def of DEFAULT_THRESHOLDS) {
        if (!existingIds.has(def.id)) raw.thresholds.push(def);
      }
      return raw;
    }
  } catch { /* ignore */ }
  return { thresholds: [...DEFAULT_THRESHOLDS], updated_at: new Date().toISOString() };
}

function saveStore(state: AlertState): void {
  writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

// ── Public API ─────────────────────────────────────────────────────

export function getThresholds(): AlertThreshold[] {
  return loadStore().thresholds;
}

export function updateThreshold(
  id: string,
  patch: Partial<Pick<AlertThreshold, "warning" | "critical" | "enabled">>,
): AlertThreshold | null {
  const store = loadStore();
  const idx = store.thresholds.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  store.thresholds[idx] = { ...store.thresholds[idx], ...patch };
  store.updated_at = new Date().toISOString();
  saveStore(store);
  return store.thresholds[idx];
}

export function resetToDefaults(): AlertThreshold[] {
  const state: AlertState = {
    thresholds: DEFAULT_THRESHOLDS.map((t) => ({ ...t })),
    updated_at: new Date().toISOString(),
  };
  saveStore(state);
  return state.thresholds;
}
