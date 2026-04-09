// BFF: Maker-Checker Approval Queue
//
// GET:  List approval requests (optionally filter by status)
// POST: Create new approval request or review (approve/reject) an existing one
//
// RBAC:
//   - Create request: admin, manager, or requester (requester can only submit ROLE_ASSIGNMENT)
//   - Approve/reject: admin or manager ONLY (and cannot be same user as requester)

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
    const auth = await requireRole(request, ["admin", "manager", "requester"]);
    if (auth.error) return auth.error;

    const { action, target, reason } = body;
    if (!action || !target || !reason) {
      return NextResponse.json({ error: "action, target, and reason are required" }, { status: 400 });
    }

    const allValidActions: ApprovalAction[] = ["SEAL", "KEY_ROTATE", "KEY_DELETE", "POLICY_DELETE", "ROLE_ASSIGNMENT"];
    const requesterAllowed: ApprovalAction[] = ["ROLE_ASSIGNMENT"];

    if (!allValidActions.includes(action)) {
      return NextResponse.json({ error: `Invalid action. Must be: ${allValidActions.join(", ")}` }, { status: 400 });
    }

    // requester can only submit ROLE_ASSIGNMENT requests
    if (auth.user!.role === "requester" && !requesterAllowed.includes(action)) {
      return NextResponse.json(
        { error: "requester role can only submit ROLE_ASSIGNMENT requests" },
        { status: 403 }
      );
    }

    const req = createApproval(action, target, auth.user!.username, auth.user!.role, reason);
    const { logCpAction } = await import("@/lib/cp-audit");
    await logCpAction({
      action: "APPROVAL_CREATE",
      performed_by: auth.user!.username,
      role: auth.user!.role,
      target,
      result: "success",
      detail: `action=${action}`,
    });
    return NextResponse.json({ success: true, message: "Approval request created", request: req });
  }

  // ── Review (approve/reject) ──────────────────────────────────
  if (body.operation === "review") {
    const auth = await requireRole(request, ["admin", "manager"]);
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
      const execResult = await executeApprovedAction(result.request.action, result.request.target, result.request.requested_by);
      markExecuted(result.request.id);
      const { logCpAction } = await import("@/lib/cp-audit");
      await logCpAction({
        action: "APPROVAL_REVIEW",
        performed_by: auth.user!.username,
        role: auth.user!.role,
        target: result.request.target,
        result: execResult.success ? "success" : "failure",
        detail: `decision=approved action=${result.request.action}`,
      });
      return NextResponse.json({
        success: true,
        message: `Request approved and executed: ${execResult.message}`,
        request: getApproval(id),
      });
    }

    const { logCpAction: log } = await import("@/lib/cp-audit");
    await log({
      action: "APPROVAL_REVIEW",
      performed_by: auth.user!.username,
      role: auth.user!.role,
      target: result.request?.target,
      result: "success",
      detail: "decision=rejected",
    });
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
  target: string,
  requestedBy: string
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

      case "ROLE_ASSIGNMENT": {
        // target format: "username:role" — assign the requested role to the user
        const [username, role] = target.split(":");
        if (!username || !role) {
          return { success: false, message: "ROLE_ASSIGNMENT target must be 'username:role'" };
        }
        const { listUsers, updateUser, createUser } = await import("@/lib/user-store");
        const users = listUsers();
        const existing = users.find((u) => u.username === username);
        if (existing) {
          updateUser(existing.id, { role: role as import("@/lib/types").Role });
          return { success: true, message: `Role '${role}' assigned to user '${username}'` };
        }
        // If user doesn't exist, create with a placeholder password (force change on login)
        const bcrypt = await import("bcryptjs");
        const tempHash = await bcrypt.hash(`${username}-tmp-${Date.now()}`, 10);
        createUser({
          username,
          passwordHash: tempHash,
          role: role as import("@/lib/types").Role,
          displayName: username,
          created_by: requestedBy,
        });
        return { success: true, message: `User '${username}' created with role '${role}'` };
      }

      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, message: `Execution failed: ${err}` };
  }
}
