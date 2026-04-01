// BFF: Transit Key Listing
// Returns SAFE metadata only — never key material.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export async function GET() {
  try {
    // List all transit keys
    const listRes = await fetch(`${VAULT_ADDR}/v1/transit/keys?list=true`, {
      cache: "no-store",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(5000),
    });

    if (!listRes.ok) {
      return NextResponse.json([]);
    }

    const listData = await listRes.json();
    const keyNames: string[] = listData?.data?.keys ?? [];

    // Fetch metadata for each key
    const keys = await Promise.all(
      keyNames.map(async (name) => {
        try {
          const res = await fetch(`${VAULT_ADDR}/v1/transit/keys/${name}`, {
            cache: "no-store",
            headers: { "X-Vault-Token": VAULT_TOKEN },
            signal: AbortSignal.timeout(5000),
          });
          const data = await res.json();
          const k = data?.data ?? {};

          // Return ONLY safe metadata — never key material
          return {
            name: k.name ?? name,
            type: k.type ?? "unknown",
            latest_version: k.latest_version ?? 1,
            min_decryption_version: k.min_decryption_version ?? 1,
            min_encryption_version: k.min_encryption_version ?? 0,
            supports_encryption: k.supports_encryption ?? false,
            supports_decryption: k.supports_decryption ?? false,
            supports_signing: k.supports_signing ?? false,
            deletion_allowed: k.deletion_allowed ?? false,
            auto_rotate_period: k.auto_rotate_period ?? 0,
            // SecOps: keys{} map with actual key data is EXCLUDED
          };
        } catch {
          return { name, type: "error", latest_version: 0, min_decryption_version: 0, min_encryption_version: 0, supports_encryption: false, supports_decryption: false, supports_signing: false, deletion_allowed: false, auto_rotate_period: 0 };
        }
      })
    );

    return NextResponse.json(keys);
  } catch {
    return NextResponse.json([]);
  }
}
