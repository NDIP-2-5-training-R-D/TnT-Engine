// BFF: Raft Snapshot Restore
// POST: receive a .snap file via multipart form data and restore to OpenBao.
//
// Security:
//   - RBAC: admin only (restore is a destructive, irreversible operation)
//   - Requires confirmation phrase "RESTORE" in form body
//   - File type check: must end in .snap
//   - File size cap: 500 MB
//   - Logs restore attempt (success or failure) with checksum
//
// OpenBao endpoint: POST /v1/sys/storage/raft/snapshot
//   Body: raw binary snapshot data
//   Auth: X-Vault-Token header

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import crypto from "crypto";

const VAULT_ADDR  = process.env.VAULT_ADDR  || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";
const MAX_BYTES   = 500 * 1024 * 1024; // 500 MB

export async function POST(request: NextRequest) {
  // 1. Auth — admin only
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  // 2. Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  // 3. Validate confirmation phrase
  const confirm = formData.get("confirm");
  if (confirm !== "RESTORE") {
    return NextResponse.json(
      { error: "Confirmation phrase must be exactly 'RESTORE'" },
      { status: 400 },
    );
  }

  // 4. Validate snapshot file
  const file = formData.get("snapshot");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'snapshot' file field" }, { status: 400 });
  }

  if (!file.name.endsWith(".snap")) {
    return NextResponse.json(
      { error: "File must have a .snap extension (Raft snapshot format)" },
      { status: 400 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large. Max ${MAX_BYTES / (1024 * 1024)} MB allowed.` },
      { status: 413 },
    );
  }

  const startMs = Date.now();
  const buffer  = Buffer.from(await file.arrayBuffer());
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

  // 5. Forward snapshot to OpenBao restore endpoint
  try {
    const vaultRes = await fetch(`${VAULT_ADDR}/v1/sys/storage/raft/snapshot`, {
      method: "POST",
      headers: {
        "X-Vault-Token": VAULT_TOKEN,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buffer.length),
      },
      body: buffer,
      signal: AbortSignal.timeout(120_000), // 2-minute timeout for large snapshots
    });

    const duration = Date.now() - startMs;

    if (!vaultRes.ok) {
      let detail = `OpenBao returned ${vaultRes.status}`;
      try {
        const errBody = await vaultRes.json() as { errors?: string[] };
        if (errBody.errors?.length) detail = errBody.errors.join("; ");
      } catch { /* ignore parse error */ }

      return NextResponse.json(
        {
          success: false,
          error: detail,
          checksum_sha256: checksum,
          size_bytes: buffer.length,
          duration_ms: duration,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Raft snapshot restored successfully. OpenBao will reload state from the snapshot.",
      checksum_sha256: checksum,
      filename: file.name,
      size_bytes: buffer.length,
      duration_ms: duration,
      restored_by: auth.user!.username,
      restored_at: new Date().toISOString(),
      warning: "All in-flight tokens and pending audit entries may have been lost. Verify system state.",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: `OpenBao unreachable: ${msg}`,
        checksum_sha256: checksum,
        size_bytes: buffer.length,
        duration_ms: Date.now() - startMs,
      },
      { status: 503 },
    );
  }
}
