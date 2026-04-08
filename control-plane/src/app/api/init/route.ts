// BFF: Vault Initialization
// POST: Initialize a new OpenBao vault with specified key shares.
//
// WARNING: This returns root token and unseal keys ONE TIME ONLY.
// The UI must display them and warn the operator to save them securely.
//
// Security:
//   - Requires X-Confirm-Action: INIT header
//   - Only works when vault is NOT initialized
//   - Root token is shown once — never stored server-side

import { NextRequest, NextResponse } from "next/server";
import { initVault, getSealStatus, VaultClientError } from "@/lib/vault-client";

export async function POST(request: NextRequest) {
  // RBAC
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  if (request.headers.get("X-Confirm-Action") !== "INIT") {
    return NextResponse.json(
      { success: false, message: "Missing X-Confirm-Action: INIT" },
      { status: 400 }
    );
  }

  // Check if already initialized
  try {
    const status = await getSealStatus();
    if (status.initialized) {
      return NextResponse.json(
        { success: false, message: "Vault is already initialized. Cannot re-initialize." },
        { status: 409 }
      );
    }
  } catch {
    // If we can't check, proceed cautiously — init will fail if already initialized
  }

  let body: { secret_shares?: number; secret_threshold?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid body" }, { status: 400 });
  }

  const shares = body.secret_shares ?? 5;
  const threshold = body.secret_threshold ?? 3;

  if (shares < 1 || shares > 10 || threshold < 1 || threshold > shares) {
    return NextResponse.json(
      { success: false, message: `Invalid params: shares=${shares}, threshold=${threshold}. Threshold must be <= shares.` },
      { status: 400 }
    );
  }

  try {
    const result = await initVault(shares, threshold);

    const { logCpAction } = await import("@/lib/cp-audit");
    await logCpAction({ action: "VAULT_INIT", performed_by: auth.user!.username, role: auth.user!.role, result: "success", detail: `shares=${shares} threshold=${threshold}` });

    // Return keys — the UI must display these ONCE and warn to save them
    return NextResponse.json({
      success: true,
      message: "Vault initialized successfully. SAVE THESE KEYS IMMEDIATELY.",
      unseal_keys: result.keys_base64 ?? result.keys,
      root_token: result.root_token,
      recovery_keys: result.recovery_keys_base64 ?? result.recovery_keys ?? [],
    });
  } catch (err) {
    const vaultErr = err instanceof VaultClientError ? err : null;
    return NextResponse.json(
      {
        success: false,
        message: vaultErr?.message ?? "Initialization failed",
      },
      { status: vaultErr?.statusCode ?? 502 }
    );
  }
}
