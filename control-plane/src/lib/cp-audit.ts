/**
 * Control Plane Audit Store
 *
 * Storage modes (CP_AUDIT_STORE env var):
 *   - "file"     (default, dev/demo) — JSON file, max 1000 entries, lost on pod restart
 *   - "postgres" (recommended for persistent multi-replica deployments)
 *   - "kafka"    (recommended for K8s) — produces to Kafka; a consumer writes to PostgreSQL.
 *                Survives pod restarts because messages stay in Kafka until consumed.
 *
 * Kafka env vars:
 *   KAFKA_BROKERS          Comma-separated broker list (e.g. "kafka:9092")
 *   KAFKA_TOPIC_CP_AUDIT   Topic name (default: "cp-audit-events")
 *   KAFKA_CLIENT_ID        Producer client ID (default: "tnt-control-plane")
 *   KAFKA_SECURITY_PROTOCOL  "plaintext" | "ssl" | "sasl_plaintext" | "sasl_ssl"
 *   KAFKA_SASL_MECHANISM   "plain" | "scram-sha-256" | "scram-sha-512"
 *   KAFKA_SASL_USERNAME
 *   KAFKA_SASL_PASSWORD
 *   KAFKA_SSL_CA           Path to CA certificate (for ssl / sasl_ssl)
 *
 * In Kafka mode, listCpAudit() falls back to PostgreSQL (CP_AUDIT_DATABASE_URL / PG_*)
 * so the dashboard can still display past events written by the consumer.
 * If PostgreSQL is also unavailable, an empty list is returned.
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

// ── Kafka config ───────────────────────────────────────────────────────

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092")
  .split(",")
  .map((b) => b.trim());
const KAFKA_TOPIC = process.env.KAFKA_TOPIC_CP_AUDIT || "cp-audit-events";
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || "tnt-control-plane";
const KAFKA_SECURITY_PROTOCOL = (
  process.env.KAFKA_SECURITY_PROTOCOL || "plaintext"
).toLowerCase() as "plaintext" | "ssl" | "sasl_plaintext" | "sasl_ssl";
const KAFKA_SASL_MECHANISM = (
  process.env.KAFKA_SASL_MECHANISM || "plain"
).toLowerCase() as "plain" | "scram-sha-256" | "scram-sha-512";
const KAFKA_SASL_USERNAME = process.env.KAFKA_SASL_USERNAME || "";
const KAFKA_SASL_PASSWORD = process.env.KAFKA_SASL_PASSWORD || "";
const KAFKA_SSL_CA = process.env.KAFKA_SSL_CA || "";

// ── Global singletons ──────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_audit_pool: PgPool | undefined;
  // eslint-disable-next-line no-var
  var __tnt_cp_audit_schema_ready: Promise<void> | undefined;
  // eslint-disable-next-line no-var
  var __tnt_cp_kafka_producer: import("kafkajs").Producer | undefined;
  // eslint-disable-next-line no-var
  var __tnt_cp_kafka_producer_ready: Promise<void> | undefined;
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

// ── Kafka helpers ──────────────────────────────────────────────────────

async function getKafkaProducer(): Promise<import("kafkajs").Producer> {
  if (!globalThis.__tnt_cp_kafka_producer) {
    const { Kafka } = (await import("kafkajs")) as typeof import("kafkajs");

    const kafkaConfig: import("kafkajs").KafkaConfig = {
      clientId: KAFKA_CLIENT_ID,
      brokers: KAFKA_BROKERS,
    };

    if (KAFKA_SECURITY_PROTOCOL === "ssl" || KAFKA_SECURITY_PROTOCOL === "sasl_ssl") {
      const fs = await import("fs");
      kafkaConfig.ssl = KAFKA_SSL_CA
        ? { ca: fs.readFileSync(KAFKA_SSL_CA) }
        : true;
    }

    if (KAFKA_SECURITY_PROTOCOL === "sasl_plaintext" || KAFKA_SECURITY_PROTOCOL === "sasl_ssl") {
      kafkaConfig.sasl = {
        mechanism: KAFKA_SASL_MECHANISM,
        username: KAFKA_SASL_USERNAME,
        password: KAFKA_SASL_PASSWORD,
      } as import("kafkajs").SASLOptions;
    }

    const kafka = new Kafka(kafkaConfig);
    const producer = kafka.producer({
      allowAutoTopicCreation: true,
      // Wait for all in-sync replicas — most durable option
      transactionTimeout: 30000,
    });

    if (!globalThis.__tnt_cp_kafka_producer_ready) {
      globalThis.__tnt_cp_kafka_producer_ready = producer.connect();
    }
    await globalThis.__tnt_cp_kafka_producer_ready;
    globalThis.__tnt_cp_kafka_producer = producer;
  }

  return globalThis.__tnt_cp_kafka_producer;
}

async function produceToKafka(record: CpAuditEntry): Promise<void> {
  const producer = await getKafkaProducer();
  await producer.send({
    topic: KAFKA_TOPIC,
    messages: [
      {
        key: record.performed_by,
        value: JSON.stringify(record),
      },
    ],
    acks: -1, // acks=all — wait for all in-sync replicas
  });
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

  // ── Kafka mode ───────────────────────────────────────────────────
  if (STORE_MODE === "kafka") {
    try {
      await produceToKafka(record);
    } catch (err) {
      // Kafka unavailable — fall back to file as a local safety net
      console.error("[cp-audit] Kafka produce failed, falling back to file:", err);
      const entries = load();
      entries.unshift(record);
      if (entries.length > MAX_ENTRIES) entries.splice(MAX_ENTRIES);
      save(entries);
    }
    return record;
  }

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
  // In Kafka mode, the consumer writes events to PostgreSQL.
  // Use PostgreSQL for querying if available; otherwise fall back to the local file cache.
  if (STORE_MODE === "kafka" || STORE_MODE === "postgres") {
    try {
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
    } catch {
      // PostgreSQL unavailable in Kafka mode — serve from local file cache
      if (STORE_MODE === "kafka") return load().slice(0, limit);
      throw; // In postgres-only mode, re-throw
    }
  }

  return load().slice(0, limit);
}

export async function cpAuditCount(): Promise<number> {
  if (STORE_MODE === "kafka" || STORE_MODE === "postgres") {
    try {
      await ensurePgSchema();
      const pool = await getPgPool();
      const result = await pool.query("SELECT COUNT(*)::int AS count FROM cp_audit_log");
      return Number(result.rows[0]?.count ?? 0);
    } catch {
      if (STORE_MODE === "kafka") return load().length;
      throw;
    }
  }

  return load().length;
}
