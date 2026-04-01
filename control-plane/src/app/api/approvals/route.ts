// BFF: Maker-Checker Approval Queue
//
// GET:  List approval requests (optionally filter by status)
// POST: Create new approval request or review (approve/reject) an existing one
//
// RBAC:
//   - Create request: admin or operator
//   - Approve/reject: admin ONLY (and cannot be same user as requester)

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  createApproval,
  listApprovals,
  reviewApproval,
  getApproval,
  markExecuted,
  type ApprovalAction,
} from "@/lib/approval-store";
import { vaultPut, vaultPost } from "@/lib/vault-client";

export async function GET(request: NextRequest) {
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const status = request.nextUrl.searchParams.get("status") as any;
  const items = listApprovals(status || undefined);

  return NextResponse.json(items);
}

export async function POST(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // ── Create a new request ─────────────────────────────────────
  if (body.operation === "create") {
    const auth = await requireRole(request, ["admin", "operator"]);
    if (auth.error) return auth.error;

    const { action, target, reason } = body;
    if (!action || !target || !reason) {
      return NextResponse.json({ error: "action, target, and reason are required" }, { status: 400 });
    }

    const validActions: ApprovalAction[] = ["SEAL", "KEY_ROTATE", "KEY_DELETE", "POLICY_DELETE"];
    if (!validActions.includes(action)) {
      return NextResponse.json({ error: `Invalid action. Must be: ${validActions.join(", ")}` }, { status: 400 });
    }

    const req = createApproval(action, target, auth.user!.username, auth.user!.role, reason);
    return NextResponse.json({ success: true, message: "Approval request created", request: req });
  }

  // ── Review (approve/reject) ──────────────────────────────────
  if (body.operation === "review") {
    const auth = await requireRole(request, ["admin"]);
    if (auth.error) return auth.error;

    const { id, decision, review_reason } = body;
    if (!id || !decision || !["approved", "rejected"].includes(decision)) {
      return NextResponse.json({ error: "id and decision (approved/rejected) are required" }, { status: 400 });
    }

    const result = reviewApproval(id, auth.user!.username, decision, review_reason);
    if (result.error) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    // If approved, execute the action
    if (decision === "approved" && result.request) {
      const execResult = await executeApprovedAction(result.request.action, result.request.target);
      markExecuted(result.request.id);
      return NextResponse.json({
        success: true,
        message: `Request approved and executed: ${execResult.message}`,
        request: getApproval(id),
      });
    }

    return NextResponse.json({
      success: true,
      message: `Request ${decision}`,
      request: result.request,
    });
  }

  return NextResponse.json({ error: "operation must be 'create' or 'review'" }, { status: 400 });
}

// ── Execute approved action against OpenBao ────────────────────

async function executeApprovedAction(
  action: ApprovalAction,
  target: string
): Promise<{ success: boolean; message: string }> {
  try {
    switch (action) {
      case "SEAL":
        await vaultPut("/sys/seal");
        return { success: true, message: "Vault sealed via approved request" };

      case "KEY_ROTATE":
        await vaultPost(`/transit/keys/${target}/rotate`);
        return { success: true, message: `Key '${target}' rotated via approved request` };

      case "KEY_DELETE":
        // Must enable deletion first, then delete
        await vaultPost(`/transit/keys/${target}/config`, { deletion_allowed: true });
        await vaultPost(`/transit/keys/${target}`, undefined); // DELETE via vault API
        return { success: true, message: `Key '${target}' deleted via approved request` };

      case "POLICY_DELETE":
        await vaultPut(`/sys/policies/acl/${target}`, undefined);
        return { success: true, message: `Policy '${target}' deleted via approved request` };

      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, message: `Execution failed: ${err}` };
  }
}
