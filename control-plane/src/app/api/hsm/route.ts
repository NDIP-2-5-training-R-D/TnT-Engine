// BFF: HSM / PKCS#11 Status
// Returns the current seal type and HSM-related diagnostics.
// If the seal type is pkcs11, attempts to parse PKCS#11 error codes.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSealStatus, parsePkcs11Error, VaultClientError } from "@/lib/vault-client";

export async function GET() {
  try {
    const status = await getSealStatus();

    const hsmInfo: Record<string, unknown> = {
      seal_type: status.type,
      is_pkcs11: status.type === "pkcs11",
      is_transit: status.type === "transit",
      is_shamir: status.type === "shamir",
      vault_sealed: status.sealed,
      vault_initialized: status.initialized,
      status: "connected",
    };

    // If using PKCS#11 seal and vault is healthy, HSM is working
    if (status.type === "pkcs11" && !status.sealed && status.initialized) {
      hsmInfo.status = "healthy";
      hsmInfo.message = "PKCS#11 seal operational — HSM connection active";
    } else if (status.type === "pkcs11" && status.sealed) {
      hsmInfo.status = "sealed";
      hsmInfo.message = "Vault is sealed. HSM was accessible at last unseal.";
    } else if (status.type !== "pkcs11") {
      hsmInfo.status = "not_configured";
      hsmInfo.message = `Seal type is '${status.type}', not PKCS#11. HSM not in use.`;
    }

    return NextResponse.json(hsmInfo);
  } catch (err) {
    const vaultErr = err instanceof VaultClientError ? err : null;
    const pkcs11Info = vaultErr ? parsePkcs11Error(vaultErr.vaultErrors) : null;

    return NextResponse.json({
      seal_type: "unknown",
      is_pkcs11: false,
      status: "error",
      vault_sealed: true,
      vault_initialized: false,
      message: vaultErr?.message ?? "Cannot reach OpenBao",
      pkcs11_error: pkcs11Info
        ? {
            code: pkcs11Info.code,
            label: pkcs11Info.label,
            suggestion: pkcs11Info.suggestion,
          }
        : null,
    });
  }
}
