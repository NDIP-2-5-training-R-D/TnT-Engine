// BFF: Single transform rule — PUT (update) and DELETE (soft-delete).
// Proxies to T&T Engine /admin/rules/{name}.
// Both operations require admin or manager role.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

type RouteContext = { params: Promise<{ name: string }> };

// ── PUT /api/transforms/[name] — update a rule (admin / manager only) ─

export async function PUT(req: NextRequest, ctx: RouteContext) {
  const auth = await requireRole(req, ["admin", "manager"]);
  if (auth.error) return auth.error;

  const { name } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${TNT_URL}/admin/rules/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: "Engine unreachable", detail: String(err) },
      { status: 503 }
    );
  }
}

// ── DELETE /api/transforms/[name] — soft-delete (admin / manager only)

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const auth = await requireRole(req, ["admin", "manager"]);
  if (auth.error) return auth.error;

  const { name } = await ctx.params;

  try {
    const res = await fetch(`${TNT_URL}/admin/rules/${encodeURIComponent(name)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: "Engine unreachable", detail: String(err) },
      { status: 503 }
    );
  }
}
