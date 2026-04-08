// BFF: Unseal Operations
//
// GET:  Returns current seal status
// POST: Submit an unseal key shard
//
// Security:
//   - Unseal keys are NEVER stored server-side — passed through to Vault
//   - Each submission requires X-Confirm-Action: UNSEAL header
//   - Reason field is required for audit trail
//   - Rate limited: 1 attempt per 5 seconds

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  getSealStatus,
  submitUnsealKey,
  VaultClientError,
  parsePkcs11Error,
} from "@/lib/vault-client";

let lastUnsealAttempt = 0;
const RATE_LIMIT_MS = 5_000;

// GET: Live seal status
export async function GET() {
  try {
    const status = await getSealStatus();
    return NextResponse.json({
      sealed: status.sealed,
      initialized: status.initialized,
      progress: status.progress,
      threshold: status.t,
      total_shares: status.n,
      seal_type: status.type,
      version: status.version,
    });
  } catch (err) {
    const vaultErr = err instanceof VaultClientError ? err : null;
    return NextResponse.json({
      sealed: true,
      initialized: false,
      progress: 0,
      threshold: 0,
      total_shares: 0,
      seal_type: "unknown",
      version: "",
      error: vaultErr?.message ?? "Cannot reach OpenBao",
      pkcs11_error: vaultErr?.pkcs11Code ? parsePkcs11Error(vaultErr.vaultErrors) : null,
    });
  }
}

// POST: Submit unseal key shard
export async function POST(request: NextRequest) {
  // RBAC
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "operator"]);
  if (auth.error) return auth.error;

  // Security: header check
  if (request.headers.get("X-Confirm-Action") !== "UNSEAL") {
    return NextResponse.json(
      { success: false, message: "Missing X-Confirm-Action: UNSEAL header" },
      { status: 400 }
    );
  }

  let body: { key?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid body" }, { status: 400 });
  }

  if (!body.key || typeof body.key !== "string" || body.key.length < 10) {
    return NextResponse.json(
      { success: false, message: "Invalid unseal key format" },
      { status: 400 }
    );
  }

  if (!body.reason || body.reason.trim().length < 3) {
    return NextResponse.json(
      { success: false, message: "Reason is required for audit trail (min 3 chars)" },
      { status: 400 }
    );
  }

  // Rate limit
  const now = Date.now();
  if (now - lastUnsealAttempt < RATE_LIMIT_MS) {
    return NextResponse.json(
      { success: false, message: "Rate limited. Wait 5 seconds between attempts." },
      { status: 429 }
    );
  }
  lastUnsealAttempt = now;

  try {
    const result = await submitUnsealKey(body.key);

    const { logCpAction } = await import("@/lib/cp-audit");
    const unsealed = !result.sealed;
    await logCpAction({
      action: "UNSEAL",
      performed_by: auth.user!.username,
      role: auth.user!.role,
      result: "success",
      detail: unsealed ? "vault_unsealed" : `progress=${result.progress}/${result.t}`,
    });

    return NextResponse.json({
      success: true,
      sealed: result.sealed,
      progress: result.progress,
      threshold: result.t,
      total_shares: result.n,
      message: result.sealed
        ? `Shard accepted. Progress: ${result.progress}/${result.t}`
        : "Vault UNSEALED successfully!",
    });
  } catch (err) {
    const vaultErr = err instanceof VaultClientError ? err : null;
    const pkcs11Info = vaultErr ? parsePkcs11Error(vaultErr.vaultErrors) : null;

    return NextResponse.json(
      {
        success: false,
        message: vaultErr?.message ?? "Unseal request failed",
        pkcs11_error: pkcs11Info,
      },
      { status: vaultErr?.statusCode ?? 502 }
    );
  }
}
