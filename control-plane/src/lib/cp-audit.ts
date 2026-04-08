/**
 * Control Plane Audit Store
 *
 * Storage modes:
 *   - file (default, dev/demo)
 *   - postgres (recommended for persistent multi-replica deployments)
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

type QueryResultRow = Record<string, unknown>;

type PgPool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;
};

const STORE_PATH = process.env.CP_AUDIT_STORE_PATH || join(tmpdir(), "tnt-cp-audit.json");
const STORE_MODE = (process.env.CP_AUDIT_STORE || "file").toLowerCase();
const MAX_ENTRIES = 1000;
const MAX_DETAIL_LENGTH = 120;
const PG_SSL = (process.env.PG_SSL || "false").toLowerCase() === "true";

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_audit_pool: PgPool | undefined;
  // eslint-disable-next-line no-var
  var __tnt_cp_audit_schema_ready: Promise<void> | undefined;
}

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

function generateId(): string {
  return `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return detail.slice(0, MAX_DETAIL_LENGTH);
}

function databaseUrl(): string {
  if (process.env.CP_AUDIT_DATABASE_URL) return process.env.CP_AUDIT_DATABASE_URL;

  const user = encodeURIComponent(process.env.PG_USER || "tnt");
  const password = encodeURIComponent(process.env.PG_PASSWORD || "tnt_secret");
  const host = process.env.PG_HOST || "localhost";
  const port = process.env.PG_PORT || "5432";
  const database = process.env.PG_DATABASE || "tnt_engine";

  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

async function getPgPool(): Promise<PgPool> {
  if (!globalThis.__tnt_cp_audit_pool) {
    const pgModule = (await import("pg")) as {
      Pool: new (config: { connectionString: string; ssl: false | { rejectUnauthorized: boolean } }) => PgPool;
    };
    globalThis.__tnt_cp_audit_pool = new pgModule.Pool({
      connectionString: databaseUrl(),
      ssl: PG_SSL ? { rejectUnauthorized: false } : false,
    });
  }

  return globalThis.__tnt_cp_audit_pool;
}

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

export async function logCpAction(
  entry: Omit<CpAuditEntry, "id" | "performed_at">
): Promise<CpAuditEntry> {
  const record: CpAuditEntry = {
    ...entry,
    detail: sanitizeDetail(entry.detail),
    id: generateId(),
    performed_at: new Date().toISOString(),
  };

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
