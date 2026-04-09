/**
 * Control Plane Audit Store
 *
 * Storage modes (CP_AUDIT_STORE env var):
 *   - "file"     (default, dev/demo) — JSON file, max 1000 entries, lost on pod restart
 *   - "postgres" (recommended for persistent multi-replica deployments)
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPgPool, type QueryResultRow } from "./db";

export type CpAction =
  | "KEY_ROTATE"
  | "SEAL"
  | "UNSEAL"
  | "POLICY_CREATE"
  | "APPROVAL_CREATE"
  | "APPROVAL_REVIEW"
  | "BACKUP_TRIGGER"
  | "APPROLE_SECRET_GEN"
  | "VAULT_INIT";

export interface CpAuditEntry {
  id: string;
  action: CpAction;
  performed_by: string;
  role: string;
  target?: string;
  result: "success" | "failure";
  detail?: string;
  performed_at: string;
}

const STORE_PATH = process.env.CP_AUDIT_STORE_PATH || join(tmpdir(), "tnt-cp-audit.json");
const STORE_MODE = (process.env.CP_AUDIT_STORE || "file").toLowerCase();
const MAX_ENTRIES = 1000;
const MAX_DETAIL_LENGTH = 120;

// ── Global singletons ──────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_audit_schema_ready: Promise<void> | undefined;
}

// ── File helpers ───────────────────────────────────────────────────────

function load(): CpAuditEntry[] {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch {
    // ignore parse/read errors and treat as empty store
  }
  return [];
}

function save(entries: CpAuditEntry[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2));
}

// ── Shared helpers ─────────────────────────────────────────────────────

function generateId(): string {
  return `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return detail.slice(0, MAX_DETAIL_LENGTH);
}

// ── PostgreSQL helpers ─────────────────────────────────────────────────

async function ensurePgSchema(): Promise<void> {
  if (!globalThis.__tnt_cp_audit_schema_ready) {
    globalThis.__tnt_cp_audit_schema_ready = (async () => {
      const pool = await getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cp_audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          performed_by TEXT NOT NULL,
          role TEXT NOT NULL,
          target TEXT,
          result TEXT NOT NULL,
          detail TEXT,
          performed_at TIMESTAMPTZ NOT NULL
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cp_audit_log_performed_at
        ON cp_audit_log (performed_at DESC)
      `);
    })();
  }

  await globalThis.__tnt_cp_audit_schema_ready;
}

function rowToEntry(row: QueryResultRow): CpAuditEntry {
  return {
    id: String(row.id),
    action: row.action as CpAction,
    performed_by: String(row.performed_by),
    role: String(row.role),
    target: row.target ? String(row.target) : undefined,
    result: row.result as "success" | "failure",
    detail: row.detail ? String(row.detail) : undefined,
    performed_at:
      row.performed_at instanceof Date
        ? row.performed_at.toISOString()
        : String(row.performed_at),
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export async function logCpAction(
  entry: Omit<CpAuditEntry, "id" | "performed_at">
): Promise<CpAuditEntry> {
  const record: CpAuditEntry = {
    ...entry,
    detail: sanitizeDetail(entry.detail),
    id: generateId(),
    performed_at: new Date().toISOString(),
  };

  // ── PostgreSQL mode ──────────────────────────────────────────────
  if (STORE_MODE === "postgres") {
    await ensurePgSchema();
    const pool = await getPgPool();
    await pool.query(
      `
        INSERT INTO cp_audit_log (id, action, performed_by, role, target, result, detail, performed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
      `,
      [
        record.id,
        record.action,
        record.performed_by,
        record.role,
        record.target ?? null,
        record.result,
        record.detail ?? null,
        record.performed_at,
      ]
    );
    return record;
  }

  // ── File mode (default) ──────────────────────────────────────────
  const entries = load();
  entries.unshift(record);
  if (entries.length > MAX_ENTRIES) entries.splice(MAX_ENTRIES);
  save(entries);
  return record;
}

export async function listCpAudit(limit = 50): Promise<CpAuditEntry[]> {
  if (STORE_MODE === "postgres") {
    await ensurePgSchema();
    const pool = await getPgPool();
    const result = await pool.query(
      `
        SELECT id, action, performed_by, role, target, result, detail, performed_at
        FROM cp_audit_log
        ORDER BY performed_at DESC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows.map(rowToEntry);
  }

  return load().slice(0, limit);
}

export async function cpAuditCount(): Promise<number> {
  if (STORE_MODE === "postgres") {
    await ensurePgSchema();
    const pool = await getPgPool();
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM cp_audit_log");
    return Number(result.rows[0]?.count ?? 0);
  }

  return load().length;
}
