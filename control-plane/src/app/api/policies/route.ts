// BFF: Policy Management
// GET: list policies or read a specific policy
// POST: create/update a policy from structured capabilities (visual builder)

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name");

  if (name) {
    // Read a specific policy
    try {
      const res = await fetch(`${VAULT_ADDR}/v1/sys/policies/acl/${name}`, {
        cache: "no-store",
        headers: { "X-Vault-Token": VAULT_TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return NextResponse.json({ name, rules: "" }, { status: 404 });
      const data = await res.json();
      return NextResponse.json({ name, rules: data?.data?.policy ?? "" });
    } catch {
      return NextResponse.json({ name, rules: "" }, { status: 502 });
    }
  }

  // List all policies
  try {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/policies/acl?list=true`, {
      cache: "no-store",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json([]);
    const data = await res.json();
    const names: string[] = data?.data?.keys ?? [];
    // Filter out root and default
    return NextResponse.json(
      names.filter((n) => n !== "root" && n !== "default").map((n) => ({ name: n }))
    );
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(request: NextRequest) {
  // RBAC
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  if (request.headers.get("X-Confirm-Action") !== "POLICY") {
    return NextResponse.json({ success: false, message: "Missing X-Confirm-Action: POLICY" }, { status: 400 });
  }

  let body: { name?: string; capabilities?: { path: string; capabilities: string[] }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid body" }, { status: 400 });
  }

  if (!body.name || !/^[a-zA-Z0-9_-]+$/.test(body.name)) {
    return NextResponse.json({ success: false, message: "Invalid policy name" }, { status: 400 });
  }

  if (!body.capabilities || !Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    return NextResponse.json({ success: false, message: "At least one capability rule is required" }, { status: 400 });
  }

  // Convert structured capabilities to HCL
  const hcl = body.capabilities
    .map((cap) => {
      const validCaps = cap.capabilities.filter((c) =>
        ["create", "read", "update", "delete", "list", "sudo"].includes(c)
      );
      return `path "${cap.path}" {\n  capabilities = [${validCaps.map((c) => `"${c}"`).join(", ")}]\n}`;
    })
    .join("\n\n");

  try {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/policies/acl/${body.name}`, {
      method: "PUT",
      cache: "no-store",
      headers: {
        "X-Vault-Token": VAULT_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ policy: hcl }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok || res.status === 204) {
      const { logCpAction } = await import("@/lib/cp-audit");
      const { emitCpEvent } = await import("@/lib/event-bus");
      logCpAction({ action: "POLICY_CREATE", performed_by: auth.user!.username, role: auth.user!.role, target: body.name, result: "success" });
      emitCpEvent({ type: "POLICY_CREATE", performed_by: auth.user!.username, target: body.name, result: "success" });
      return NextResponse.json({ success: true, message: `Policy '${body.name}' saved.` });
    }
    const { logCpAction: log } = await import("@/lib/cp-audit");
    log({ action: "POLICY_CREATE", performed_by: auth.user!.username, role: auth.user!.role, target: body.name, result: "failure", detail: `HTTP ${res.status}` });
    return NextResponse.json({ success: false, message: `Save failed: HTTP ${res.status}` }, { status: 502 });
  } catch (err) {
    const { logCpAction: log } = await import("@/lib/cp-audit");
    log({ action: "POLICY_CREATE", performed_by: auth.user!.username, role: auth.user!.role, target: body.name, result: "failure", detail: String(err) });
    return NextResponse.json({ success: false, message: `Save failed: ${err}` }, { status: 502 });
  }
}
