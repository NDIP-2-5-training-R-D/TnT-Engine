// BFF: Token revoke — marks token REVOKED (reversible, token remains in DB).
// POST { token, tenant_id }
// RBAC: admin or manager

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ["admin", "manager"]);
  if (auth.error) return auth.error;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { token, tenant_id } = body as Record<string, unknown>;
  if (typeof token !== "string" || !token.trim()) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }
  if (typeof tenant_id !== "string" || !tenant_id.trim()) {
    return NextResponse.json({ error: "tenant_id is required" }, { status: 400 });
  }

  try {
    const res = await fetch(`${TNT_URL}/api/v1/token/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim(), tenant_id: tenant_id.trim() }),
      signal: AbortSignal.timeout(10_000),
    });
    const resBody = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        { error: String(resBody.detail ?? "Revoke failed") },
        { status: res.status },
      );
    }
    return NextResponse.json({
      success: true,
      status: "revoked",
      token: token.trim(),
      revoked_by: auth.user!.username,
      revoked_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `T&T Engine unreachable: ${msg}` }, { status: 503 });
  }
}
