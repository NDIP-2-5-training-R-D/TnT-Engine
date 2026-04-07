// POST /api/backups/schedule/execute
//
// Designed to be called by an external cron job (K8s CronJob, system cron)
// OR manually triggered via the dashboard.
//
// Security:
//   - Primary:  Authorization: Bearer <BACKUP_EXECUTOR_TOKEN> (from env)
//   - Fallback: Session-based auth (admin | operator) when token env is unset
//
// Body (optional JSON):
//   { force?: boolean }   — if true, skip the "is it time yet?" check

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  getSchedule,
  recordBackup,
  recordScheduledRun,
  computeNextRun,
} from "@/lib/backup-store";

const VAULT_ADDR           = process.env.VAULT_ADDR           || "http://localhost:8200";
const VAULT_TOKEN          = process.env.VAULT_TOKEN          || "";
const BACKUP_EXECUTOR_TOKEN = process.env.BACKUP_EXECUTOR_TOKEN || "";
const BACKUP_DIR           = "/tmp/tnt-vault-backups";

// ── Auth helpers ──────────────────────────────────────────────────

/**
 * Verify the incoming request using:
 *   1. Bearer token (BACKUP_EXECUTOR_TOKEN), if the env var is set.
 *   2. Session-based RBAC (admin | operator) as a fallback.
 *
 * Returns null on success, or a NextResponse with the appropriate
 * 401/403 on failure.
 */
async function authorize(request: NextRequest): Promise<NextResponse | null> {
  // Primary: static bearer token
  if (BACKUP_EXECUTOR_TOKEN) {
    const authHeader = request.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (token === BACKUP_EXECUTOR_TOKEN) return null; // authorized

    // Token env is set but header is wrong/missing — reject immediately.
    return NextResponse.json(
      { error: "Invalid or missing Bearer token", code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  // Fallback: session RBAC
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "operator"]);
  return auth.error; // null = ok, NextResponse = denied
}

// ── Retention enforcement ─────────────────────────────────────────

async function enforceRetention(retentionCount: number): Promise<void> {
  try {
    const { readdirSync, statSync, unlinkSync } = await import("fs");
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".snap"))
      .map((f) => ({
        name: f,
        path: `${BACKUP_DIR}/${f}`,
        mtime: statSync(`${BACKUP_DIR}/${f}`).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const toDelete = files.slice(retentionCount);
    for (const file of toDelete) {
      try { unlinkSync(file.path); } catch { /* ignore individual delete errors */ }
    }
  } catch { /* directory may not exist yet */ }
}

// ── Main handler ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth
  const authError = await authorize(request);
  if (authError) return authError;

  // Parse body (optional)
  let force = false;
  try {
    const body = await request.json();
    force = body?.force === true;
  } catch { /* body is optional */ }

  // Load schedule
  const schedule = getSchedule();

  // Guard: enabled?
  if (!schedule.enabled) {
    return NextResponse.json({ executed: false, reason: "schedule disabled" });
  }

  // Guard: is it time to run?
  if (!force) {
    // Compute next_run_at on-the-fly in case it wasn't persisted yet
    const nextRun = schedule.next_run_at ?? computeNextRun(schedule);
    if (nextRun !== null && Date.now() < Date.parse(nextRun)) {
      return NextResponse.json({
        executed: false,
        reason: "not due yet",
        next_run_at: nextRun,
      });
    }
  }

  // ── Execute backup ──────────────────────────────────────────────
  const t0 = Date.now();

  // Resolve vault version for metadata
  let vaultVersion = "";
  try {
    const healthRes = await fetch(`${VAULT_ADDR}/v1/sys/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const health = await healthRes.json();
    vaultVersion = health.version ?? "";
  } catch { /* non-fatal */ }

  // Download raft snapshot
  let snapshotRes: Response;
  try {
    snapshotRes = await fetch(`${VAULT_ADDR}/v1/sys/storage/raft/snapshot`, {
      headers: { "X-Vault-Token": VAULT_TOKEN },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    // Network / timeout error
    const record = recordBackup({
      timestamp: new Date().toISOString(),
      size_bytes: 0,
      checksum_sha256: "",
      storage_location: "",
      status: "failed",
      triggered_by: "scheduled",
      vault_version: vaultVersion,
      duration_ms: Date.now() - t0,
      error: String(err),
    });
    recordScheduledRun("failed");
    return NextResponse.json(
      { executed: true, error: String(err), backup: record },
      { status: 502 }
    );
  }

  if (!snapshotRes.ok) {
    const errMsg = `Vault HTTP ${snapshotRes.status}`;
    const record = recordBackup({
      timestamp: new Date().toISOString(),
      size_bytes: 0,
      checksum_sha256: "",
      storage_location: "",
      status: "failed",
      triggered_by: "scheduled",
      vault_version: vaultVersion,
      duration_ms: Date.now() - t0,
      error: errMsg,
    });
    recordScheduledRun("failed");
    return NextResponse.json(
      { executed: true, error: errMsg, backup: record },
      { status: 502 }
    );
  }

  // Read snapshot into buffer
  const buffer = Buffer.from(await snapshotRes.arrayBuffer());
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const filename = `vault_raft_scheduled_${Date.now()}.snap`;
  const storagePath = `${BACKUP_DIR}/${filename}`;

  // Write to disk
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(storagePath, buffer);

  // Record metadata
  const record = recordBackup({
    timestamp: new Date().toISOString(),
    size_bytes: buffer.length,
    checksum_sha256: checksum,
    storage_location: `local:${storagePath}`,
    status: "completed",
    triggered_by: "scheduled",
    vault_version: vaultVersion,
    duration_ms: Date.now() - t0,
  });

  // Update schedule run tracking
  recordScheduledRun("success");

  // Enforce retention: delete old .snap files beyond retention_count
  await enforceRetention(schedule.retention_count);

  return NextResponse.json({
    executed: true,
    backup: record,
    duration_ms: Date.now() - t0,
  });
}
