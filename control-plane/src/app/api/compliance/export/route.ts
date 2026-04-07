/**
 * POST /api/compliance/export
 *
 * Generates a regulatory-grade compliance report from T&T Engine audit data.
 * Supports CSV and JSON export formats.
 *
 * Request body:
 *   from_date   ISO date string (start of period)
 *   to_date     ISO date string (end of period)
 *   tenant_id   Optional: filter to a single tenant
 *   format      "csv" | "json" (default: "json")
 *   include_pii_summary  boolean — include breakdown by field type
 *
 * Response:
 *   - Content-Disposition: attachment; filename="compliance-report-*.csv|json"
 *   - Body: CSV or JSON compliance report
 *
 * RBAC: admin and operator only.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";

const TNT_URL = process.env.TNT_ENGINE_URL ?? "http://localhost:8000";

// ── Types ──────────────────────────────────────────────────────────

interface AuditEntry {
  id?: string;
  tenant_id?: string;
  action?: string;
  field_type?: string;
  status?: string;
  created_at?: string;
  transformation?: string;
  masked_token?: string;
}

interface ComplianceSummary {
  generated_at: string;
  report_period: { from: string; to: string };
  tenant_filter: string | null;
  total_operations: number;
  successful_operations: number;
  failed_operations: number;
  error_rate_pct: number;
  operations_by_type: Record<string, number>;
  pii_fields_processed: Record<string, number>;
  tenants_covered: string[];
}

// ── Helpers ────────────────────────────────────────────────────────

function buildSummary(
  entries: AuditEntry[],
  from: string,
  to: string,
  tenantFilter: string | null,
): ComplianceSummary {
  const opCounts: Record<string, number> = {};
  const fieldCounts: Record<string, number> = {};
  const tenantSet = new Set<string>();
  let successful = 0;
  let failed = 0;

  for (const e of entries) {
    const action = e.action ?? e.transformation ?? "UNKNOWN";
    opCounts[action] = (opCounts[action] ?? 0) + 1;

    if (e.field_type) {
      fieldCounts[e.field_type] = (fieldCounts[e.field_type] ?? 0) + 1;
    }
    if (e.tenant_id) tenantSet.add(e.tenant_id);
    if (e.status === "SUCCESS" || e.status === "200" || !e.status) successful++;
    else failed++;
  }

  const total = entries.length;
  return {
    generated_at: new Date().toISOString(),
    report_period: { from, to },
    tenant_filter: tenantFilter,
    total_operations: total,
    successful_operations: successful,
    failed_operations: failed,
    error_rate_pct: total > 0 ? Math.round((failed / total) * 10000) / 100 : 0,
    operations_by_type: opCounts,
    pii_fields_processed: fieldCounts,
    tenants_covered: Array.from(tenantSet).sort(),
  };
}

function toCsv(entries: AuditEntry[], summary: ComplianceSummary): string {
  const header = [
    "# T&T Engine Compliance Report",
    `# Generated: ${summary.generated_at}`,
    `# Period: ${summary.report_period.from} — ${summary.report_period.to}`,
    `# Tenant filter: ${summary.tenant_filter ?? "all"}`,
    `# Total operations: ${summary.total_operations}`,
    `# Error rate: ${summary.error_rate_pct}%`,
    "",
    "## Operation Summary",
    "operation,count",
    ...Object.entries(summary.operations_by_type).map(([k, v]) => `${k},${v}`),
    "",
    "## PII Fields Processed",
    "field_type,count",
    ...Object.entries(summary.pii_fields_processed).map(([k, v]) => `${k},${v}`),
    "",
    "## Audit Log Entries",
    "id,tenant_id,action,field_type,status,created_at",
  ].join("\n");

  const rows = entries.map((e) =>
    [
      e.id ?? "",
      e.tenant_id ?? "",
      e.action ?? e.transformation ?? "",
      e.field_type ?? "",
      e.status ?? "SUCCESS",
      e.created_at ?? "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );

  return header + "\n" + rows.join("\n");
}

// ── Route handler ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const authResult = await requireRole(request, ["admin", "operator"]);
  if (authResult.error) return authResult.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fromDate = (body.from_date as string) || new Date(Date.now() - 30 * 86400_000).toISOString();
  const toDate = (body.to_date as string) || new Date().toISOString();
  const tenantId = (body.tenant_id as string) || null;
  const format = ((body.format as string) || "json").toLowerCase();
  const includePiiSummary = body.include_pii_summary !== false;

  if (!["csv", "json"].includes(format)) {
    return NextResponse.json({ error: "format must be 'csv' or 'json'" }, { status: 400 });
  }

  // ── Fetch audit entries from T&T Engine ────────────────────────
  let entries: AuditEntry[] = [];
  try {
    const queryBody: Record<string, unknown> = {
      limit: 10000,
      since: fromDate,
      until: toDate,
    };
    if (tenantId) queryBody.tenant_id = tenantId;

    const res = await fetch(`${TNT_URL}/admin/audit/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryBody),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = await res.json();
      entries = data.entries ?? [];
    }
  } catch {
    // Return report with empty entries if engine is unreachable
  }

  const summary = buildSummary(entries, fromDate, toDate, tenantId);

  // ── Build filename ─────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 10);
  const tenantSlug = tenantId ? `-${tenantId}` : "";
  const filename = `compliance-report${tenantSlug}-${stamp}.${format}`;

  // ── JSON export ────────────────────────────────────────────────
  if (format === "json") {
    const report = {
      summary,
      ...(includePiiSummary ? {} : { pii_fields_processed: undefined }),
      entries,
    };
    return new NextResponse(JSON.stringify(report, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // ── CSV export ─────────────────────────────────────────────────
  const csv = toCsv(entries, summary);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
