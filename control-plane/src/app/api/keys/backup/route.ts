// BFF: Raft Snapshot Backup
// Downloads OpenBao raft snapshot as a binary file.
// Rate limited: 1 backup per 5 minutes.
// Response headers force browser download (no rendering).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

let lastBackup = 0;
const RATE_LIMIT_MS = 5 * 60_000; // 5 minutes

export async function POST(request: NextRequest) {
  // RBAC
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "operator"]);
  if (auth.error) return auth.error;

  const now = Date.now();
  if (now - lastBackup < RATE_LIMIT_MS) {
    const remaining = Math.ceil((RATE_LIMIT_MS - (now - lastBackup)) / 1000);
    return NextResponse.json(
      { success: false, message: `Rate limited. Try again in ${remaining}s` },
      { status: 429 }
    );
  }
  lastBackup = now;

  try {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/storage/raft/snapshot`, {
      cache: "no-store",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(60_000), // Snapshots can be large
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, message: `Snapshot failed: HTTP ${res.status}` },
        { status: 502 }
      );
    }

    const blob = await res.arrayBuffer();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    return new NextResponse(blob, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="vault_raft_${timestamp}.snap"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `Backup failed: ${err}` },
      { status: 502 }
    );
  }
}
