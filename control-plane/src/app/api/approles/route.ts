// BFF: AppRole Management
// GET: list AppRole roles and their metadata
// POST: generate a new secret_id for a role

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

export async function GET() {
  try {
    const listRes = await fetch(`${VAULT_ADDR}/v1/auth/approle/role?list=true`, {
      cache: "no-store",
      headers: { "X-Vault-Token": VAULT_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!listRes.ok) return NextResponse.json([]);
    const listData = await listRes.json();
    const roleNames: string[] = listData?.data?.keys ?? [];

    const roles = await Promise.all(
      roleNames.map(async (name) => {
        try {
          const res = await fetch(`${VAULT_ADDR}/v1/auth/approle/role/${name}`, {
            cache: "no-store",
            headers: { "X-Vault-Token": VAULT_TOKEN },
          });
          const data = await res.json();
          const r = data?.data ?? {};
          return {
            role_name: name,
            token_ttl: r.token_ttl ?? 0,
            token_max_ttl: r.token_max_ttl ?? 0,
            token_policies: r.token_policies ?? [],
            bind_secret_id: r.bind_secret_id ?? true,
            secret_id_num_uses: r.secret_id_num_uses ?? 0,
          };
        } catch {
          return { role_name: name, token_ttl: 0, token_max_ttl: 0, token_policies: [], bind_secret_id: true, secret_id_num_uses: 0 };
        }
      })
    );

    return NextResponse.json(roles);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(request: NextRequest) {
  // RBAC
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin", "operator"]);
  if (auth.error) return auth.error;

  if (request.headers.get("X-Confirm-Action") !== "GENERATE") {
    return NextResponse.json({ success: false, message: "Missing X-Confirm-Action: GENERATE" }, { status: 400 });
  }

  let body: { role_name?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid body" }, { status: 400 });
  }

  if (!body.role_name || body.action !== "generate_secret_id") {
    return NextResponse.json({ success: false, message: "Invalid request" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${VAULT_ADDR}/v1/auth/approle/role/${body.role_name}/secret-id`,
      {
        method: "POST",
        cache: "no-store",
        headers: { "X-Vault-Token": VAULT_TOKEN },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      return NextResponse.json({ success: false, message: `Generate failed: HTTP ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    const { logCpAction } = await import("@/lib/cp-audit");
    const { emitCpEvent } = await import("@/lib/event-bus");
    logCpAction({ action: "APPROLE_SECRET_GEN", performed_by: auth.user!.username, role: auth.user!.role, target: body.role_name, result: "success" });
    emitCpEvent({ type: "APPROLE_SECRET_GEN", performed_by: auth.user!.username, target: body.role_name, result: "success" });
    // SecOps: secret_id is returned ONCE — client must display and mask after 30s
    return NextResponse.json({
      secret_id: data?.data?.secret_id ?? "",
      secret_id_accessor: data?.data?.secret_id_accessor ?? "",
    });
  } catch (err) {
    return NextResponse.json({ success: false, message: `Generate failed: ${err}` }, { status: 502 });
  }
}
