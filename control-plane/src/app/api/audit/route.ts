// BFF: Audit log — status + real entries from T&T Engine
//
// GET /api/audit?limit=50&tenant=acme&action=TOKENIZE&since=2026-04-01T00:00:00Z
//
// Queries the T&T Engine's /admin/audit/query endpoint for real entries
// and /admin/audit/status for buffer/DLQ metadata.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

export async function GET(request: NextRequest) {
  const limit = request.nextUrl.searchParams.get("limit") || "50";
  const tenant = request.nextUrl.searchParams.get("tenant") || "";
  const action = request.nextUrl.searchParams.get("action") || "";
  const since = request.nextUrl.searchParams.get("since") || "";

  // RBAC: any authenticated user can view audit
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  // 1. Fetch buffer status
  let bufferSize = 0;
  let dlqSizeBytes = 0;
  try {
    const statusRes = await fetch(`${TNT_URL}/admin/audit/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (statusRes.ok) {
      const s = await statusRes.json();
      bufferSize = s.buffer_size ?? 0;
      dlqSizeBytes = s.dlq_size_bytes ?? 0;
    }
  } catch { /* ignore */ }

  // 2. Fetch real audit entries via query endpoint
  let entries: any[] = [];
  try {
    const queryBody: Record<string, any> = { limit: parseInt(limit) };
    if (tenant) queryBody.tenant_id = tenant;
    if (action) queryBody.action = action;
    if (since) queryBody.since = since;

    const queryRes = await fetch(`${TNT_URL}/admin/audit/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryBody),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    if (queryRes.ok) {
      const data = await queryRes.json();
      entries = data.entries ?? [];
    }
  } catch { /* ignore — entries stay empty */ }

  return NextResponse.json({
    buffer_size: bufferSize,
    dlq_size_bytes: dlqSizeBytes,
    entries,
    count: entries.length,
  });
}
