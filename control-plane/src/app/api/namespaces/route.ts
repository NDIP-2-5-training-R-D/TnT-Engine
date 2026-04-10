// BFF: List and create OpenBao namespaces.
// GET  — Returns namespaces the current user can access ("root" always included).
// POST — Creates a new namespace (admin only).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { vaultRequest, VaultClientError } from "@/lib/vault-client";

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

export async function POST(request: NextRequest) {
  // Admin-only: only admins can create namespaces
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = (body?.name ?? "").trim().toLowerCase();

  // Validate: only lowercase letters, digits, and hyphens
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    return NextResponse.json(
      { error: "Namespace name must be non-empty and match [a-z0-9-]+" },
      { status: 400 }
    );
  }

  if (name === "root") {
    return NextResponse.json(
      { error: "Cannot create a namespace named 'root'" },
      { status: 400 }
    );
  }

  try {
    // OpenBao API: POST /v1/sys/namespaces/<name>
    await vaultRequest(`/sys/namespaces/${encodeURIComponent(name)}`, {
      method: "POST",
    });
    return NextResponse.json({ namespace: name }, { status: 201 });
  } catch (err) {
    if (err instanceof VaultClientError) {
      return NextResponse.json(
        { error: err.vaultErrors.join(", ") || err.message },
        { status: err.statusCode }
      );
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
