/**
 * Backup metadata store — tracks Raft snapshots with verification status.
 *
 * Stores metadata (not the actual snapshot) about each backup:
 *   - timestamp, size, checksum, storage location, status
 *
 * The actual snapshot is downloaded via the existing /api/keys/backup route
 * or stored by the server-side scheduled job.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";

export type BackupStatus = "completed" | "failed" | "verified" | "expired";

export interface BackupRecord {
  id: string;
  timestamp: string;
  size_bytes: number;
  checksum_sha256: string;
  storage_location: string;  // "local:/tmp/..." or "s3://..."
  status: BackupStatus;
  triggered_by: string;      // "scheduled" | "manual:<username>"
  vault_version: string;
  duration_ms: number;
  error?: string;
}

export interface BackupScheduleConfig {
  enabled: boolean;
  interval_hours: number;
  retention_count: number;        // Keep last N backups
  cron_expression?: string;       // Optional cron expr (e.g. "0 */4 * * *") for display
  last_run_at?: string;           // ISO timestamp of last execution
  last_run_status?: "success" | "failed";
  next_run_at?: string;           // Calculated: last_run_at + interval_hours
}

const STORE_PATH = process.env.BACKUP_STORE_PATH || "/tmp/tnt-backup-metadata.json";

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
    schedule: {
      enabled: false,
      interval_hours: 4,
      retention_count: 10,
      cron_expression: "0 */4 * * *",
    },
  };
}

function saveStore(data: StoreData): void {
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

// ── Backup Records ─────────────────────────────────────────────────

export function recordBackup(record: Omit<BackupRecord, "id">): BackupRecord {
  const store = loadStore();
  const entry: BackupRecord = { id: `bak_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, ...record };
  store.backups.unshift(entry); // newest first
  // Enforce retention
  if (store.backups.length > store.schedule.retention_count * 2) {
    store.backups = store.backups.slice(0, store.schedule.retention_count * 2);
  }
  saveStore(store);
  return entry;
}

export function listBackups(limit: number = 20): BackupRecord[] {
  return loadStore().backups.slice(0, limit);
}

export function getBackup(id: string): BackupRecord | undefined {
  return loadStore().backups.find((b) => b.id === id);
}

export function markVerified(id: string): void {
  const store = loadStore();
  const bak = store.backups.find((b) => b.id === id);
  if (bak) { bak.status = "verified"; saveStore(store); }
}

// ── Schedule Config ────────────────────────────────────────────────

export function getSchedule(): BackupScheduleConfig {
  return loadStore().schedule;
}

export function updateSchedule(config: Partial<BackupScheduleConfig>): BackupScheduleConfig {
  const store = loadStore();
  store.schedule = { ...store.schedule, ...config };
  // Recompute next_run_at if interval changed while last_run_at is present
  if (config.interval_hours !== undefined && store.schedule.last_run_at) {
    store.schedule.next_run_at = computeNextRun(store.schedule) ?? undefined;
  }
  saveStore(store);
  return store.schedule;
}

// ── Schedule Execution Helpers ─────────────────────────────────────

/**
 * Calculates the next run time based on last_run_at + interval_hours.
 * Returns null when last_run_at is not set (first run).
 */
export function computeNextRun(schedule: BackupScheduleConfig): string | null {
  if (!schedule.last_run_at) return null;
  const last = Date.parse(schedule.last_run_at);
  if (isNaN(last)) return null;
  const next = new Date(last + schedule.interval_hours * 60 * 60 * 1000);
  return next.toISOString();
}

/**
 * Records the result of a scheduled run:
 * - updates last_run_at to now
 * - updates last_run_status
 * - recomputes next_run_at
 */
export function recordScheduledRun(status: "success" | "failed"): BackupScheduleConfig {
  const store = loadStore();
  const now = new Date().toISOString();
  store.schedule.last_run_at = now;
  store.schedule.last_run_status = status;
  store.schedule.next_run_at = computeNextRun(store.schedule) ?? undefined;
  saveStore(store);
  return store.schedule;
}
