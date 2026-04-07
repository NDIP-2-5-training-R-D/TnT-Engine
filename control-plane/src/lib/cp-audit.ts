/**
 * Control Plane Audit Store
 *
 * Persists every mutative action performed via the Control Plane UI:
 * who did what, when, on which target, and whether it succeeded.
 *
 * Storage: file-backed (/tmp/tnt-cp-audit.json) — migrate to PostgreSQL for prod (4.2).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
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
  target?: string;       // key name, policy name, role name, etc.
  result: "success" | "failure";
  detail?: string;       // e.g. "New version: 3", error message on failure
  performed_at: string;  // ISO timestamp
}

const STORE_PATH = process.env.CP_AUDIT_STORE_PATH || join(tmpdir(), "tnt-cp-audit.json");
const MAX_ENTRIES = 1000; // rotate when exceeded

// ── Storage helpers ────────────────────────────────────────────────

function load(): CpAuditEntry[] {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch { /* ignore parse errors */ }
  return [];
}

function save(entries: CpAuditEntry[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2));
}

function generateId(): string {
  return `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Public API ─────────────────────────────────────────────────────

/** Record a Control Plane action. Call after the action completes (success or failure). */
export function logCpAction(entry: Omit<CpAuditEntry, "id" | "performed_at">): CpAuditEntry {
  const record: CpAuditEntry = {
    ...entry,
    id: generateId(),
    performed_at: new Date().toISOString(),
  };

  const entries = load();
  entries.unshift(record); // newest first

  // Keep store bounded
  if (entries.length > MAX_ENTRIES) entries.splice(MAX_ENTRIES);

  save(entries);
  return record;
}

/** List recent CP audit entries, newest first. */
export function listCpAudit(limit = 50): CpAuditEntry[] {
  return load().slice(0, limit);
}

/** Count total stored entries. */
export function cpAuditCount(): number {
  return load().length;
}
