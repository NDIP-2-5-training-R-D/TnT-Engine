/**
 * Role-Based Access Control (RBAC) for Control Plane API routes.
 *
 * Permissions matrix:
 *   admin     → ALL actions (seal, unseal, rotate, delete, policy, approve, backup, restore, manage users)
 *   manager   → Full permissions within namespace (rotate, backup, policy, approve, delete, seal, unseal)
 *               Can approve/reject requester requests. Cannot manage system-level users.
 *   requester → Read-only + generate_secret_id. Cannot approve. Cannot manage other users.
 *               Must submit ROLE_ASSIGNMENT requests for manager/admin to approve.
 *
 * Usage in API routes:
 *   import { requireRole } from "@/lib/rbac";
 *   const auth = await requireRole(request, ["admin", "manager"]);
 *   if (auth.error) return auth.error;
 *   // auth.user is available
 */

import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authOptions } from "./auth-options";
import type { Role } from "./types";

export interface AuthResult {
  user: { id: string; username: string; role: Role; displayName: string } | null;
  error: NextResponse | null;
}

/** Check session and enforce role. Returns user or error response. */
export async function requireRole(
  _request: NextRequest,
  allowedRoles: Role[]
): Promise<AuthResult> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return {
      user: null,
      error: NextResponse.json(
        { error: "Authentication required", code: "AUTH_REQUIRED" },
        { status: 401 }
      ),
    };
  }

  const userRole = (session.user as any).role as Role;
  if (!allowedRoles.includes(userRole)) {
    return {
      user: null,
      error: NextResponse.json(
        {
          error: `Role '${userRole}' is not permitted for this action. Required: ${allowedRoles.join(" or ")}`,
          code: "FORBIDDEN",
        },
        { status: 403 }
      ),
    };
  }

  return {
    user: {
      id: (session.user as any).id,
      username: (session.user as any).username,
      role: userRole,
      displayName: session.user.name || "",
    },
    error: null,
  };
}

/** Read-only check — any authenticated user */
export async function requireAuth(_request: NextRequest): Promise<AuthResult> {
  return requireRole(_request, ["admin", "manager", "requester"]);
}

/** Permission definitions for documentation */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [
    "view_dashboard", "view_audit", "view_keys", "view_policies",
    "rotate_key", "seal_vault", "unseal_vault", "init_vault",
    "create_policy", "generate_secret_id", "backup", "restore",
    "approve_action", "delete_key", "manage_users",
  ],
  manager: [
    "view_dashboard", "view_audit", "view_keys", "view_policies",
    "rotate_key", "seal_vault", "unseal_vault",
    "create_policy", "generate_secret_id", "backup",
    "approve_action", "delete_key",
  ],
  requester: [
    "view_dashboard", "view_audit", "view_keys", "view_policies",
    "generate_secret_id",
  ],
};
