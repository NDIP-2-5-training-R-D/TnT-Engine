// BFF: Emergency Seal endpoint
// Seals OpenBao. This is an IRREVERSIBLE action that stops ALL crypto operations.
//
// Security:
//   - Requires X-Confirm-Action: SEAL header
//   - Requires body { confirm: "SEAL-CONFIRM" } exact match
//   - Rate limited: 1 request per 60 seconds (in-memory)
//   - VAULT_TOKEN used server-side only — never exposed to client

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

// Simple in-memory rate limiter
let lastSealAttempt = 0;
const RATE_LIMIT_MS = 60_000; // 1 minute

export async function POST(request: NextRequest) {
  // RBAC: admin only
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  // Security check 1: Required header
  const confirmHeader = request.headers.get("X-Confirm-Action");
  if (confirmHeader !== "SEAL") {
    return NextResponse.json(
      { success: false, message: "Missing X-Confirm-Action: SEAL header" },
      { status: 400 }
    );
  }

  // Security check 2: Required body confirmation
  let body: { confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }

  if (body.confirm !== "SEAL-CONFIRM") {
    return NextResponse.json(
      { success: false, message: "Confirmation phrase mismatch. Expected: SEAL-CONFIRM" },
      { status: 400 }
    );
  }

  // Security check 3: Rate limiting
  const now = Date.now();
  if (now - lastSealAttempt < RATE_LIMIT_MS) {
    const remaining = Math.ceil((RATE_LIMIT_MS - (now - lastSealAttempt)) / 1000);
    return NextResponse.json(
      { success: false, message: `Rate limited. Try again in ${remaining}s` },
      { status: 429 }
    );
  }

  lastSealAttempt = now;

  // Execute seal
  try {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/seal`, {
      method: "PUT",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 204 || res.ok) {
      return NextResponse.json({
        success: true,
        message: "OpenBao has been SEALED. All crypto operations are now disabled.",
        sealed: true,
      });
    }

    return NextResponse.json(
      { success: false, message: `Seal failed: HTTP ${res.status}`, sealed: false },
      { status: 502 }
    );
  } catch (err) {
    return NextResponse.json(
      { success: false, message: `Seal request failed: ${err}`, sealed: false },
      { status: 502 }
    );
  }
}
