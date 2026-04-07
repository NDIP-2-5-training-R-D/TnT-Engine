// BFF: Backup Management API
//
// GET:  List backup history + schedule config
// POST: Trigger manual backup or update schedule config

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  listBackups, recordBackup, getSchedule, updateSchedule,
} from "@/lib/backup-store";
import crypto from "crypto";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export async function GET(request: NextRequest) {
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  return NextResponse.json({
    backups: listBackups(30),
    schedule: getSchedule(),
  });
}

export async function POST(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "operator"]);
  if (auth.error) return auth.error;

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }

  // Update schedule config
  if (body.operation === "update_schedule") {
    const config = updateSchedule({
      enabled: body.enabled,
      interval_hours: body.interval_hours,
      retention_count: body.retention_count,
    });
    return NextResponse.json({ success: true, schedule: config });
  }

  // Trigger manual backup
  if (body.operation === "trigger") {
    const t0 = Date.now();
    try {
      // Get vault version for metadata
      let vaultVersion = "";
      try {
        const healthRes = await fetch(`${VAULT_ADDR}/v1/sys/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
        const health = await healthRes.json();
        vaultVersion = health.version || "";
      } catch { /* ignore */ }

      // Download raft snapshot
      const res = await fetch(`${VAULT_ADDR}/v1/sys/storage/raft/snapshot`, {
        headers: { "X-Vault-Token": VAULT_TOKEN },
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const record = recordBackup({
          timestamp: new Date().toISOString(),
          size_bytes: 0,
          checksum_sha256: "",
          storage_location: "",
          status: "failed",
          triggered_by: `manual:${auth.user!.username}`,
          vault_version: vaultVersion,
          duration_ms: Date.now() - t0,
          error: `HTTP ${res.status}`,
        });
        return NextResponse.json({ success: false, backup: record }, { status: 502 });
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
      const filename = `vault_raft_${Date.now()}.snap`;
      const storagePath = `/tmp/tnt-vault-backups/${filename}`;

      // Write to local storage
      const { mkdirSync, writeFileSync } = await import("fs");
      mkdirSync("/tmp/tnt-vault-backups", { recursive: true });
      writeFileSync(storagePath, buffer);

      const record = recordBackup({
        timestamp: new Date().toISOString(),
        size_bytes: buffer.length,
        checksum_sha256: checksum,
        storage_location: `local:${storagePath}`,
        status: "completed",
        triggered_by: `manual:${auth.user!.username}`,
        vault_version: vaultVersion,
        duration_ms: Date.now() - t0,
      });

      const { logCpAction } = await import("@/lib/cp-audit");
      const { emitCpEvent } = await import("@/lib/event-bus");
      logCpAction({ action: "BACKUP_TRIGGER", performed_by: auth.user!.username, role: auth.user!.role, result: "success", detail: `${(buffer.length / 1024).toFixed(1)} KB sha256=${checksum.slice(0, 8)}...` });
      emitCpEvent({ type: "BACKUP_TRIGGER", performed_by: auth.user!.username, result: "success", detail: `${(buffer.length / 1024).toFixed(1)} KB` });

      return NextResponse.json({ success: true, backup: record });
    } catch (err) {
      const record = recordBackup({
        timestamp: new Date().toISOString(),
        size_bytes: 0,
        checksum_sha256: "",
        storage_location: "",
        status: "failed",
        triggered_by: `manual:${auth.user!.username}`,
        vault_version: "",
        duration_ms: Date.now() - t0,
        error: String(err),
      });
      return NextResponse.json({ success: false, backup: record }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "operation must be 'trigger' or 'update_schedule'" }, { status: 400 });
}
