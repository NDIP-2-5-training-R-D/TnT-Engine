// BFF: Key Rotation endpoint
// Rotates a transit key to a new version. IRREVERSIBLE — new version becomes active.
//
// Security:
//   - Requires X-Confirm-Action: ROTATE header
//   - Requires body { key_name: "name", confirm: "ROTATE-<name>" }
//   - Rate limited: 1 rotation per 30 seconds per key

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

const lastRotation: Record<string, number> = {};
const RATE_LIMIT_MS = 30_000;

export async function POST(request: NextRequest) {
  // RBAC: admin or operator
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "operator"]);
  if (auth.error) return auth.error;

  // Security: header check
  if (request.headers.get("X-Confirm-Action") !== "ROTATE") {
    return NextResponse.json({ success: false, message: "Missing X-Confirm-Action: ROTATE" }, { status: 400 });
  }

  let body: { key_name?: string; confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid body" }, { status: 400 });
  }

  const keyName = body.key_name;
  if (!keyName || typeof keyName !== "string" || !/^[a-zA-Z0-9_-]+$/.test(keyName)) {
    return NextResponse.json({ success: false, message: "Invalid key name" }, { status: 400 });
  }

  // Confirm phrase must match pattern
  if (body.confirm !== `ROTATE-${keyName}`) {
    return NextResponse.json({ success: false, message: `Confirmation mismatch. Expected: ROTATE-${keyName}` }, { status: 400 });
  }

  // Rate limit per key
  const now = Date.now();
  if (lastRotation[keyName] && now - lastRotation[keyName] < RATE_LIMIT_MS) {
    return NextResponse.json({ success: false, message: "Rate limited. Wait 30s between rotations." }, { status: 429 });
  }
  lastRotation[keyName] = now;

  try {
    const res = await fetch(`${VAULT_ADDR}/v1/transit/keys/${keyName}/rotate`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok || res.status === 204) {
      // Fetch updated key info for new version
      const infoRes = await fetch(`${VAULT_ADDR}/v1/transit/keys/${keyName}`, {
        cache: "no-store",
        headers: { "X-Vault-Token": VAULT_TOKEN },
      });
      const info = await infoRes.json();
      const newVersion = info?.data?.latest_version ?? 0;

      try {
        const { logCpAction } = await import("@/lib/cp-audit");
        await logCpAction({ action: "KEY_ROTATE", performed_by: auth.user!.username, role: auth.user!.role, target: keyName, result: "success", detail: `New version: ${newVersion}` });
      } catch { /* audit must never break the main flow */ }

      return NextResponse.json({
        success: true,
        message: `Key '${keyName}' rotated successfully.`,
        new_version: newVersion,
      });
    }

    try {
      const { logCpAction } = await import("@/lib/cp-audit");
      await logCpAction({ action: "KEY_ROTATE", performed_by: auth.user!.username, role: auth.user!.role, target: keyName, result: "failure", detail: `HTTP ${res.status}` });
    } catch { /* ignore */ }
    return NextResponse.json({ success: false, message: `Rotation failed: HTTP ${res.status}` }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ success: false, message: `Rotation request failed: ${err}` }, { status: 502 });
  }
}
