/**
 * Alert threshold store
 *
 * Storage modes (ALERT_STORE env var):
 *   - "file"     (default) → /tmp/tnt-alert-config.json, lost on pod restart
 *   - "postgres"           → cp_alert_thresholds table, persists across restarts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getPgPool, type QueryResultRow } from "./db";

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
const STORE_MODE = (process.env.ALERT_STORE || "file").toLowerCase();

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

// ── Schema setup ───────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_alert_schema_ready: Promise<void> | undefined;
}

async function ensureSchema(): Promise<void> {
  if (!globalThis.__tnt_cp_alert_schema_ready) {
    globalThis.__tnt_cp_alert_schema_ready = (async () => {
      const pool = await getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cp_alert_thresholds (
          metric_name    VARCHAR(100) PRIMARY KEY,
          display_name   VARCHAR(100) NOT NULL,
          description    TEXT,
          metric_key     VARCHAR(100) NOT NULL,
          warning_value  NUMERIC      NOT NULL,
          critical_value NUMERIC      NOT NULL,
          unit           VARCHAR(20)  NOT NULL DEFAULT '',
          direction      VARCHAR(10)  NOT NULL DEFAULT 'above',
          enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
          updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
      `);
      // Auto-seed on first run
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS count FROM cp_alert_thresholds"
      );
      if (Number(rows[0]?.count) === 0) {
        for (const t of DEFAULT_THRESHOLDS) {
          await pool.query(
            `INSERT INTO cp_alert_thresholds
               (metric_name, display_name, description, metric_key, warning_value, critical_value, unit, direction, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (metric_name) DO NOTHING`,
            [t.id, t.name, t.description, t.metric_key, t.warning, t.critical, t.unit, t.direction, t.enabled]
          );
        }
      }
    })();
  }
  await globalThis.__tnt_cp_alert_schema_ready;
}

function rowToThreshold(row: QueryResultRow): AlertThreshold {
  return {
    id:          String(row.metric_name),
    name:        String(row.display_name),
    description: String(row.description ?? ""),
    metric_key:  String(row.metric_key),
    warning:     Number(row.warning_value),
    critical:    Number(row.critical_value),
    unit:        String(row.unit ?? ""),
    direction:   String(row.direction) as AlertDirection,
    enabled:     Boolean(row.enabled),
  };
}

// ── File mode helpers ──────────────────────────────────────────────

function loadStore(): AlertState {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as AlertState;
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

export async function getThresholds(): Promise<AlertThreshold[]> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      "SELECT * FROM cp_alert_thresholds ORDER BY metric_name"
    );
    return rows.map(rowToThreshold);
  }
  return loadStore().thresholds;
}

export async function updateThreshold(
  id: string,
  patch: Partial<Pick<AlertThreshold, "warning" | "critical" | "enabled">>,
): Promise<AlertThreshold | null> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const setClauses: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    if (patch.warning  !== undefined) { params.push(patch.warning);  setClauses.push(`warning_value = $${params.length}`); }
    if (patch.critical !== undefined) { params.push(patch.critical); setClauses.push(`critical_value = $${params.length}`); }
    if (patch.enabled  !== undefined) { params.push(patch.enabled);  setClauses.push(`enabled = $${params.length}`); }
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE cp_alert_thresholds SET ${setClauses.join(", ")} WHERE metric_name = $${params.length} RETURNING *`,
      params
    );
    return rows.length ? rowToThreshold(rows[0]) : null;
  }

  // File mode
  const store = loadStore();
  const idx = store.thresholds.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  store.thresholds[idx] = { ...store.thresholds[idx], ...patch };
  store.updated_at = new Date().toISOString();
  saveStore(store);
  return store.thresholds[idx];
}

export async function resetToDefaults(): Promise<AlertThreshold[]> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    for (const t of DEFAULT_THRESHOLDS) {
      await pool.query(
        `UPDATE cp_alert_thresholds
         SET warning_value=$1, critical_value=$2, enabled=$3, updated_at=NOW()
         WHERE metric_name=$4`,
        [t.warning, t.critical, t.enabled, t.id]
      );
    }
    return getThresholds();
  }

  const state: AlertState = {
    thresholds: DEFAULT_THRESHOLDS.map((t) => ({ ...t })),
    updated_at: new Date().toISOString(),
  };
  saveStore(state);
  return state.thresholds;
}
