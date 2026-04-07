// BFF: Token Lifecycle — list and stats
// GET /api/tokens?tenant_id=&status=&transformation=&limit=&offset=
//
// Proxies to T&T Engine GET /admin/tokens.
// Returns safe metadata only — no plaintext, no ciphertext.
// RBAC: admin or operator (viewer has no lifecycle access).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ["admin", "operator"]);
  if (auth.error) return auth.error;

  const { searchParams } = request.nextUrl;
  const params = new URLSearchParams();

  const tenant = searchParams.get("tenant_id") ?? "";
  const status = searchParams.get("status") ?? "";
  const transformation = searchParams.get("transformation") ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 200);
  const offset = Math.max(Number(searchParams.get("offset") ?? "0"), 0);

  if (tenant)         params.set("tenant_id", tenant);
  if (status)         params.set("status", status);
  if (transformation) params.set("transformation", transformation);
  params.set("limit",  String(limit));
  params.set("offset", String(offset));

  try {
    const res = await fetch(`${TNT_URL}/admin/tokens?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        { error: String((body as { detail?: string }).detail ?? "T&T Engine error") },
        { status: res.status },
      );
    }
    return NextResponse.json(body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `T&T Engine unreachable: ${msg}` }, { status: 503 });
  }
}
