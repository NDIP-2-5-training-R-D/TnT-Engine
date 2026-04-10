/**
 * Field classification store — file or PostgreSQL mode.
 *
 * Storage modes (CLASSIFICATION_STORE env var):
 *   - "file"     (default) → /tmp/tnt-classification.json
 *   - "postgres"           → cp_field_classifications table
 *
 * The store keeps an in-memory cache seeded from SEED data on startup,
 * then refreshed from DB/file asynchronously — keeping classifyField() synchronous.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SensitivityLevel } from "./types";
import { getPgPool, type QueryResultRow } from "./db";

export interface Classification {
  level: SensitivityLevel;
  allowed: string[];
}

const STORE_PATH =
  process.env.CLASSIFICATION_STORE_PATH || join(tmpdir(), "tnt-classification.json");
const STORE_MODE = (process.env.CLASSIFICATION_STORE || "file").toLowerCase();

// ── Seed data (mirrors classification.py) ─────────────────────────

export const CLASSIFICATION_SEED: Record<string, Classification> = {
  ssn:             { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  card:            { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  credit_card:     { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  tax_id:          { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  bank_account:    { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  passport:        { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  email:           { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  phone:           { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  date_of_birth:   { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  drivers_license: { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  name:            { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  first_name:      { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  last_name:       { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  address:         { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  city:            { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  zip_code:        { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
};

export const UNCLASSIFIED: Classification = {
  level: "UNCLASSIFIED",
  allowed: ["TOKENIZE", "MASK", "HMAC"],
};

// ── In-memory cache (sync interface) ──────────────────────────────

let _cache: Record<string, Classification> = { ...CLASSIFICATION_SEED };

// ── Schema setup ───────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_classification_schema_ready: Promise<void> | undefined;
}

async function ensureSchema(): Promise<void> {
  if (!globalThis.__tnt_cp_classification_schema_ready) {
    globalThis.__tnt_cp_classification_schema_ready = (async () => {
      const pool = await getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cp_field_classifications (
          field_name        VARCHAR(100) PRIMARY KEY,
          sensitivity_level VARCHAR(20)  NOT NULL,
          allowed_operations TEXT[]      NOT NULL DEFAULT '{}',
          updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
      `);
      // Auto-seed on first run
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS count FROM cp_field_classifications"
      );
      if (Number(rows[0]?.count) === 0) {
        await _seedToDb();
      }
    })();
  }
  await globalThis.__tnt_cp_classification_schema_ready;
}

// ── File helpers ───────────────────────────────────────────────────

function loadFile(): Record<string, Classification> {
  try {
    if (existsSync(STORE_PATH))
      return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Record<string, Classification>;
  } catch { /* ignore */ }
  return { ...CLASSIFICATION_SEED };
}

function saveFile(data: Record<string, Classification>): void {
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function rowToClassification(row: QueryResultRow): Classification {
  return {
    level: String(row.sensitivity_level) as SensitivityLevel,
    allowed: Array.isArray(row.allowed_operations) ? (row.allowed_operations as string[]) : [],
  };
}

// ── Internal seed helper ───────────────────────────────────────────

async function _seedToDb(): Promise<void> {
  const pool = await getPgPool();
  for (const [field, c] of Object.entries(CLASSIFICATION_SEED)) {
    await pool.query(
      `INSERT INTO cp_field_classifications (field_name, sensitivity_level, allowed_operations)
       VALUES ($1, $2, $3)
       ON CONFLICT (field_name) DO NOTHING`,
      [field, c.level, c.allowed]
    );
  }
}

// ── Cache refresh (called on module load & periodically) ───────────

export async function refreshCache(): Promise<void> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      "SELECT field_name, sensitivity_level, allowed_operations FROM cp_field_classifications"
    );
    _cache = Object.fromEntries(
      rows.map((r) => [String(r.field_name), rowToClassification(r)])
    );
  } else {
    _cache = loadFile();
  }
}

// Warm cache on module import (fire-and-forget, SEED used until ready)
void refreshCache();

// ── Public API ─────────────────────────────────────────────────────

/** Synchronous — uses in-memory cache (refreshed async). */
export function classifyFieldSync(fieldName: string): Classification {
  return _cache[fieldName.toLowerCase()] ?? UNCLASSIFIED;
}

export async function getClassification(fieldName: string): Promise<Classification> {
  const key = fieldName.toLowerCase();
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      "SELECT sensitivity_level, allowed_operations FROM cp_field_classifications WHERE field_name = $1",
      [key]
    );
    return rows.length ? rowToClassification(rows[0]) : UNCLASSIFIED;
  }
  return loadFile()[key] ?? UNCLASSIFIED;
}

export async function listClassifications(): Promise<Record<string, Classification>> {
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    const { rows } = await pool.query(
      "SELECT field_name, sensitivity_level, allowed_operations FROM cp_field_classifications ORDER BY sensitivity_level, field_name"
    );
    return Object.fromEntries(rows.map((r) => [String(r.field_name), rowToClassification(r)]));
  }
  return loadFile();
}

export async function upsertClassification(
  fieldName: string,
  c: Classification
): Promise<void> {
  const key = fieldName.toLowerCase();
  if (STORE_MODE === "postgres") {
    await ensureSchema();
    const pool = await getPgPool();
    await pool.query(
      `INSERT INTO cp_field_classifications (field_name, sensitivity_level, allowed_operations, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (field_name) DO UPDATE
         SET sensitivity_level   = EXCLUDED.sensitivity_level,
             allowed_operations  = EXCLUDED.allowed_operations,
             updated_at          = NOW()`,
      [key, c.level, c.allowed]
    );
  } else {
    const data = loadFile();
    data[key] = c;
    saveFile(data);
  }
  _cache[key] = c; // update in-memory cache immediately
}
