// BFF: List available OpenBao namespaces
// Returns namespaces the current user can access.
// "root" is always included as the default.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export async function GET(request: NextRequest) {
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const namespaces = ["root"];

  try {
    // Try to list namespaces (Enterprise/OpenBao feature)
    const res = await fetch(`${VAULT_ADDR}/v1/sys/namespaces?list=true`, {
      cache: "no-store",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const keys: string[] = data?.data?.keys ?? [];
      namespaces.push(...keys.map((k: string) => k.replace(/\/$/, "")));
    }
  } catch {
    // Namespace listing not available (OSS/dev mode) — return root only
  }

  return NextResponse.json({ namespaces });
}
