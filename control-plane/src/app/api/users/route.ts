// BFF: User Management — List & Create
//
// GET  /api/users  — List all managed users (admin only, no passwordHash)
// POST /api/users  — Create a new user (admin only)
//
// If AUTH_PROVIDER is "ldap" or "oidc", GET returns a managed:false notice
// and POST is disabled.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { listUsers, createUser } from "@/lib/user-store";
import type { Role } from "@/lib/types";

// Strip passwordHash before sending to client
function sanitize(user: ReturnType<typeof listUsers>[number]) {
  const { passwordHash: _hash, ...safe } = user;
  return safe;
}

export async function GET(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  const provider = process.env.AUTH_PROVIDER ?? "credentials";
  if (provider === "ldap" || provider === "oidc") {
    const label = provider === "ldap" ? "LDAP" : "OIDC";
    return NextResponse.json({
      managed: false,
      message: `User management is handled by the external identity provider (${label})`,
    });
  }

  const users = listUsers().map(sanitize);
  return NextResponse.json({ users });
}

export async function POST(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  const provider = process.env.AUTH_PROVIDER ?? "credentials";
  if (provider === "ldap" || provider === "oidc") {
    return NextResponse.json(
      { error: "User creation is disabled when using an external identity provider" },
      { status: 403 }
    );
  }

  let body: { username?: string; password?: string; role?: string; displayName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { username, password, role, displayName } = body;

  // ── Validation ────────────────────────────────────────────────────

  if (!username || !password || !role || !displayName) {
    return NextResponse.json(
      { error: "username, password, role, and displayName are required" },
      { status: 400 }
    );
  }

  // Username: 3-30 chars, alphanumeric + underscore + hyphen, no spaces
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
    return NextResponse.json(
      {
        error:
          "username must be 3-30 characters and contain only letters, numbers, underscores, or hyphens",
      },
      { status: 400 }
    );
  }

  const validRoles: Role[] = ["admin", "manager", "requester"];
  if (!validRoles.includes(role as Role)) {
    return NextResponse.json(
      { error: `role must be one of: ${validRoles.join(", ")}` },
      { status: 400 }
    );
  }

  // Check for duplicate username
  const existing = listUsers().find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (existing) {
    return NextResponse.json(
      { error: `Username '${username}' is already taken` },
      { status: 409 }
    );
  }

  // ── Hash password ─────────────────────────────────────────────────

  const passwordHash = await bcrypt.hash(password, 12);

  // ── Create user ───────────────────────────────────────────────────

  const newUser = createUser({
    username,
    passwordHash,
    role: role as Role,
    displayName,
    created_by: auth.user!.username,
  });

  return NextResponse.json({ user: sanitize(newUser) }, { status: 201 });
}
