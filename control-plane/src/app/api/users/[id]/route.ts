// BFF: User Management — Update & Delete by ID
//
// PUT    /api/users/[id]  — Update role, status, displayName, or passwordHash (admin only)
// DELETE /api/users/[id]  — Deactivate or hard-delete a user (admin only)
//
// Constraints:
//   - Cannot change your own role
//   - Cannot delete/deactivate yourself
//   - Cannot delete the last admin
//   - If permanent=false on DELETE, sets status=inactive
//   - If permanent=true on DELETE, removes the record

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { listUsers, updateUser, deleteUser } from "@/lib/user-store";
import type { Role } from "@/lib/types";

function sanitize(user: ReturnType<typeof listUsers>[number]) {
  const { passwordHash: _hash, ...safe } = user;
  return safe;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  const { id } = params;

  let body: {
    role?: string;
    displayName?: string;
    status?: string;
    force_password_change?: boolean;
    password?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Find the target user
  const target = listUsers().find((u) => u.id === id);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Cannot change own role
  if (body.role && auth.user!.id === id) {
    return NextResponse.json(
      { error: "You cannot change your own role" },
      { status: 403 }
    );
  }

  // Validate role if provided
  const validRoles: Role[] = ["admin", "operator", "viewer"];
  if (body.role && !validRoles.includes(body.role as Role)) {
    return NextResponse.json(
      { error: `role must be one of: ${validRoles.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate status if provided
  if (body.status && !["active", "inactive"].includes(body.status)) {
    return NextResponse.json(
      { error: "status must be 'active' or 'inactive'" },
      { status: 400 }
    );
  }

  // Build patch object
  const patch: Parameters<typeof updateUser>[1] = {};
  if (body.role) patch.role = body.role as Role;
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  if (body.status) patch.status = body.status as "active" | "inactive";
  if (body.force_password_change !== undefined)
    patch.force_password_change = body.force_password_change;

  // Handle password reset
  if (body.password) {
    patch.passwordHash = await bcrypt.hash(body.password, 12);
    patch.force_password_change = true;
  }

  try {
    const updated = updateUser(id, patch);
    return NextResponse.json({ user: sanitize(updated) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  const { id } = params;

  // Cannot delete yourself
  if (auth.user!.id === id) {
    return NextResponse.json(
      { error: "You cannot delete or deactivate your own account" },
      { status: 403 }
    );
  }

  // Find the target user
  const target = listUsers().find((u) => u.id === id);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let body: { permanent?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // body is optional — default to soft-delete
  }

  const permanent = body.permanent === true;

  if (permanent) {
    // Hard delete — will fail if last admin
    const ok = deleteUser(id);
    if (!ok) {
      return NextResponse.json(
        { error: "Cannot delete the last active admin account" },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, message: "User permanently deleted" });
  } else {
    // Soft delete — set status inactive
    // Guard: if this would leave no active admins
    if (target.role === "admin") {
      const activeAdmins = listUsers().filter(
        (u) => u.role === "admin" && u.status === "active"
      );
      if (activeAdmins.length <= 1) {
        return NextResponse.json(
          { error: "Cannot deactivate the last active admin account" },
          { status: 409 }
        );
      }
    }

    try {
      const updated = updateUser(id, { status: "inactive" });
      return NextResponse.json({
        success: true,
        message: "User deactivated",
        user: sanitize(updated),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Deactivation failed";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
}
