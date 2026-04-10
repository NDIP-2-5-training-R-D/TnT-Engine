/**
 * Shared PostgreSQL connection pool for the control-plane.
 *
 * All stores import getPgPool() from here instead of creating their own connection.
 * Connection params (same as T&T Engine):
 *   PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_SSL
 * Or single URL: CP_DATABASE_URL (falls back to CP_AUDIT_DATABASE_URL for compat)
 */

export type QueryResultRow = Record<string, unknown>;

export type PgPool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;
};

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_pg_pool: PgPool | undefined;
}

function databaseUrl(): string {
  if (process.env.CP_DATABASE_URL) return process.env.CP_DATABASE_URL;
  if (process.env.CP_AUDIT_DATABASE_URL) return process.env.CP_AUDIT_DATABASE_URL; // backward compat

  const user = encodeURIComponent(process.env.PG_USER || "tnt");
  const password = encodeURIComponent(process.env.PG_PASSWORD || "tnt_secret");
  const host = process.env.PG_HOST || "localhost";
  const port = process.env.PG_PORT || "5432";
  const database = process.env.PG_DATABASE || "tnt_engine";

  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

const PG_SSL = (process.env.PG_SSL || "false").toLowerCase() === "true";

export async function getPgPool(): Promise<PgPool> {
  if (!globalThis.__tnt_cp_pg_pool) {
    const pgModule = (await import("pg")) as {
      Pool: new (config: {
        connectionString: string;
        ssl: false | { rejectUnauthorized: boolean };
      }) => PgPool;
    };
    globalThis.__tnt_cp_pg_pool = new pgModule.Pool({
      connectionString: databaseUrl(),
      ssl: PG_SSL ? { rejectUnauthorized: false } : false,
    });
  }
  return globalThis.__tnt_cp_pg_pool;
}
