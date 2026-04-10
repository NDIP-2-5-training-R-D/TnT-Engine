/**
 * Backup metadata store
 *
 * Storage modes (BACKUP_STORE env var):
 *   - "file"     (default) → /tmp/tnt-backup-metadata.json, lost on pod restart
 *   - "postgres"           → cp_backup_records + cp_backup_schedule tables
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";
import { getPgPool, type QueryResultRow } from "./db";

export type BackupStatus = "completed" | "failed" | "verified" | "expired";

export interface BackupRecord {
  id: string;
  timestamp: string;
  size_bytes: number;
  checksum_sha256: string;
  storage_location: string;
  status: BackupStatus;
  triggered_by: string;
  vault_version: string;
  duration_ms: number;
  error?: string;
}

export interface BackupScheduleConfig {
  enabled: boolean;
  interval_hours: number;
  retention_count: number;
  cron_expression?: string;
  last_run_at?: string;
  last_run_status?: "success" | "failed";
  next_run_at?: string;
}

const STORE_PATH = process.env.BACKUP_STORE_PATH || "/tmp/tnt-backup-metadata.json";
const STORE_MODE = (process.env.BACKUP_STORE || "file").toLowerCase();

// ── Schema setup ───────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_backup_schema_ready: Promise<void> | undefined;
}

async function ensureSchema(): Promise<void> {
  if (!globalThis.__tnt_cp_backup_schema_ready) {
    globalThis.__tnt_cp_backup_schema_ready = (async () => {
      const pool = await getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cp_backup_records (
          id               VARCHAR(50)  PRIMARY KEY,
          triggered_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          size_bytes       BIGINT,
          checksum_sha256  VARCHAR(64),
          storage_location TEXT,
          status           VARCHAR(20)  NOT NULL,
          triggered_by     VARCHAR(100) NOT NULL DEFAULT 'manual',
          vault_version    VARCHAR(50),
          duration_ms      INT,
          error_detail     TEXT
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cp_backup_records_triggered_at
        ON cp_backup_records (triggered_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cp_backup_schedule (
          id               INT         PRIMARY KEY DEFAULT 1,
          enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
          interval_hours   INT         NOT NULL DEFAULT 4,
          retention_count  INT         NOT NULL DEFAULT 10,
          cron_expression  VARCHAR(50) NOT NULL DEFAULT '0 */4 * * *',
          last_run_at      TIMESTAMPTZ,
          last_run_status  VARCHAR(10),
          next_run_at      TIMESTAMPTZ,
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        "INSERT INTO cp_backup_schedule (id) VALUES (1) ON CONFLICT (id) DO NOTHING"
      );
    })();
  }
  await globalThis.__tnt_cp_backup_schema_ready;
}

function rowToRecord(row: QueryResultRow): BackupRecord {
  return {
    id:               String(row.id),
    timestamp:        row.triggered_at instanceof Date
                        ? row.triggered_at.toISOString()
                        : String(row.triggered_at),
    size_bytes:       Number(row.size_bytes ?? 0),
    checksum_sha256:  String(row.checksum_sha256 ?? ""),
    storage_location: String(row.storage_location ?? ""),
    status:           String(row.status) as BackupStatus,
    triggered_by:     String(row.triggered_by ?? "manual"),
    vault_version:    String(row.vault_version ?? ""),
    duration_ms:      Number(row.duration_ms ?? 0),
    error:            row.error_detail ? String(row.error_detail) : undefined,
  };
}

function rowToSchedule(row: QueryResultRow): BackupScheduleConfig {
  return {
    enabled:          Boolean(row.enabled),
    interval_hours:   Number(row.interval_hours),
    retention_count:  Number(row.retention_count),
    cron_expression:  String(row.cron_expression ?? "0 */4 * * *"),
    last_run_at:      row.last_run_at
                        ? (row.last_run_at instanceof Date
                            ? row.last_run_at.toISOString()
                            : String(row.last_run_at))
                        : undefined,
    last_run_status:  row.last_run_status
                        ? (String(row.last_run_status) as "success" | "failed")
                        : undefined,
    next_run_at:      row.next_run_at
                        ? (row.next_run_at instanceof Date
                            ? row.next_run_at.toISOString()
                            : String(row.next_run_at))
                        : undefined,
  };
}

// ── File mode helpers ──────────────────────────────────────────────

interface StoreData {
  backups: BackupRecord[];
  schedule: BackupScheduleConfig;
}

function loadStore(): StoreData {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch { /* ignore */ }
  return {
    backups: [],
    schedule: { enabled: false, interval_hours: 4, retention_count: 10, cron_expression: "0 */4 * * *" },
  };
}

function saveStore(data: StoreData): void {
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

// ── Backup Records ─────────────────────────────────────────────────

export async function recordBackup(record: Omit<BackupRecord, "id">): Promise<BackupRecord> {
  const id = `bak_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      `INSERT INTO cp_backup_records
         (id, triggered_at, size_bytes, checksum_sha256, storage_location, status, triggered_by, vault_version, duration_ms, error_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        record.timestamp,
        record.size_bytes,
        record.checksum_sha256,
        record.storage_location,
        record.status,
        record.triggered_by,
        record.vault_version,
        record.duration_ms,
        record.error ?? null,
      ]
    );
    return rowToRecord(rows[0]);
  }

  const store = loadStore();
  const entry: BackupRecord = { id, ...record };
  store.backups.unshift(entry);
  if (store.backups.length > store.schedule.retention_count * 2) {
    store.backups = store.backups.slice(0, store.schedule.retention_count * 2);
  }
  saveStore(store);
  return entry;
}

export async function listBackups(limit = 20): Promise<BackupRecord[]> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      "SELECT * FROM cp_backup_records ORDER BY triggered_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(rowToRecord);
  }
  return loadStore().backups.slice(0, limit);
}

export async function getBackup(id: string): Promise<BackupRecord | undefined> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      "SELECT * FROM cp_backup_records WHERE id = $1",
      [id]
    );
    return rows.length ? rowToRecord(rows[0]) : undefined;
  }
  return loadStore().backups.find((b) => b.id === id);
}

export async function markVerified(id: string): Promise<void> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    await pool.query(
      "UPDATE cp_backup_records SET status = 'verified' WHERE id = $1",
      [id]
    );
    return;
  }
  const store = loadStore();
  const bak = store.backups.find((b) => b.id === id);
  if (bak) { bak.status = "verified"; saveStore(store); }
}

// ── Schedule Config ────────────────────────────────────────────────

export async function getSchedule(): Promise<BackupScheduleConfig> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query("SELECT * FROM cp_backup_schedule WHERE id = 1");
    return rows.length ? rowToSchedule(rows[0]) : { enabled: false, interval_hours: 4, retention_count: 10 };
  }
  return loadStore().schedule;
}

export async function updateSchedule(
  config: Partial<BackupScheduleConfig>
): Promise<BackupScheduleConfig> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const setClauses: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); setClauses.push(`${col} = $${params.length}`); };
    if (config.enabled         !== undefined) add("enabled",         config.enabled);
    if (config.interval_hours  !== undefined) add("interval_hours",  config.interval_hours);
    if (config.retention_count !== undefined) add("retention_count", config.retention_count);
    if (config.cron_expression !== undefined) add("cron_expression", config.cron_expression);
    params.push(1); // WHERE id = $N
    const { rows } = await pool.query(
      `UPDATE cp_backup_schedule SET ${setClauses.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return rowToSchedule(rows[0]);
  }

  const store = loadStore();
  store.schedule = { ...store.schedule, ...config };
  if (config.interval_hours !== undefined && store.schedule.last_run_at) {
    store.schedule.next_run_at = computeNextRun(store.schedule) ?? undefined;
  }
  saveStore(store);
  return store.schedule;
}

// ── Schedule Execution Helpers ─────────────────────────────────────

export function computeNextRun(schedule: BackupScheduleConfig): string | null {
  if (!schedule.last_run_at) return null;
  const last = Date.parse(schedule.last_run_at);
  if (isNaN(last)) return null;
  return new Date(last + schedule.interval_hours * 3_600_000).toISOString();
}

export async function recordScheduledRun(
  status: "success" | "failed"
): Promise<BackupScheduleConfig> {
  const now = new Date().toISOString();

  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const schedule = await getSchedule();
    const next = computeNextRun({ ...schedule, last_run_at: now });
    const { rows } = await pool.query(
      `UPDATE cp_backup_schedule
       SET last_run_at=$1, last_run_status=$2, next_run_at=$3, updated_at=NOW()
       WHERE id=1 RETURNING *`,
      [now, status, next]
    );
    return rowToSchedule(rows[0]);
  }

  const store = loadStore();
  store.schedule.last_run_at = now;
  store.schedule.last_run_status = status;
  store.schedule.next_run_at = computeNextRun(store.schedule) ?? undefined;
  saveStore(store);
  return store.schedule;
}
