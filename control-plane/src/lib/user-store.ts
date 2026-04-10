/**
 * Managed User Store — file-based persistence at /tmp/tnt-user-store.json.
 *
 * Extends the static built-in users from src/lib/users.ts.
 * On first load, seeds the file with the 3 built-in users (hashes only, no plaintext).
 *
 * Roles:
 *   - admin:     full system access
 *   - manager:   full access within namespace, can approve requests
 *   - requester: read-only + generate secrets, must request role assignments via approval
 *
 * Constraints:
 *   - Cannot delete the last admin
 *   - IDs are prefixed "usr_"
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Role } from "./types";

export interface ManagedUser {
  id: string;
  username: string;
  passwordHash: string;           // bcrypt hash
  role: Role;
  displayName: string;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
  last_login_at?: string;
  created_by: string;             // username of creator, or "system"
  force_password_change: boolean;
}

const STORE_PATH = process.env.USER_STORE_PATH || "/tmp/tnt-user-store.json";

// ── Seed data from static users.ts (hashes only) ──────────────────

const SEED_USERS: ManagedUser[] = [
  {
    id: "usr_admin_001",
    username: "admin",
    passwordHash: "$2a$10$rQZKQYGp7bVK0VzF.Kx3YOqhHW3nHE8nZJHv1UFyV0nBXsR9TjWG6",
    role: "admin",
    displayName: "System Admin",
    status: "active",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    created_by: "system",
    force_password_change: false,
  },
  {
    id: "usr_manager_001",
    username: "manager",
    passwordHash: "$2a$10$LN1E8kP0H7hW8QjV4NM5HeZxR0qKpO9L2z5E9X1s3sF4K7tDq8nWi",
    role: "manager",
    displayName: "Namespace Manager",
    status: "active",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    created_by: "system",
    force_password_change: false,
  },
  {
    id: "usr_requester_001",
    username: "requester",
    passwordHash: "$2a$10$9fZ0rLJK1hqW5Q8X3vT7aegHN0xJ2sV4F6pB0m7cR1kE8n5Y3wUdS",
    role: "requester",
    displayName: "Service Requester",
    status: "active",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    created_by: "system",
    force_password_change: false,
  },
];

// ── Internal helpers ───────────────────────────────────────────────

function loadStore(): ManagedUser[] {
  if (!existsSync(STORE_PATH)) {
    // First run — seed with built-in users
    writeFileSync(STORE_PATH, JSON.stringify(SEED_USERS, null, 2));
    return [...SEED_USERS];
  }
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as ManagedUser[];
  } catch {
    // Corrupt file — return seed as fallback (don't overwrite)
    return [...SEED_USERS];
  }
}

function saveStore(users: ManagedUser[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(users, null, 2));
}

function generateId(): string {
  return `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ─────────────────────────────────────────────────────

/** Return all users. */
export function listUsers(): ManagedUser[] {
  return loadStore();
}

/** Create a new managed user. */
export function createUser(data: {
  username: string;
  passwordHash: string;
  role: Role;
  displayName: string;
  created_by: string;
}): ManagedUser {
  const store = loadStore();
  const now = new Date().toISOString();

  const user: ManagedUser = {
    id: generateId(),
    username: data.username,
    passwordHash: data.passwordHash,
    role: data.role,
    displayName: data.displayName,
    status: "active",
    created_at: now,
    updated_at: now,
    created_by: data.created_by,
    force_password_change: true,
  };

  store.push(user);
  saveStore(store);
  return user;
}

/** Update role, displayName, status, or force_password_change for a user. */
export function updateUser(
  id: string,
  patch: {
    role?: Role;
    displayName?: string;
    status?: "active" | "inactive";
    force_password_change?: boolean;
    passwordHash?: string;
  }
): ManagedUser {
  const store = loadStore();
  const idx = store.findIndex((u) => u.id === id);
  if (idx === -1) throw new Error(`User '${id}' not found`);

  const updated: ManagedUser = {
    ...store[idx],
    ...patch,
    updated_at: new Date().toISOString(),
  };
  store[idx] = updated;
  saveStore(store);
  return updated;
}

/**
 * Delete or deactivate a user.
 * Returns false if the user is the last admin (cannot delete).
 */
export function deleteUser(id: string): boolean {
  const store = loadStore();
  const user = store.find((u) => u.id === id);
  if (!user) return false;

  // Guard: cannot remove the last admin
  if (user.role === "admin") {
    const adminCount = store.filter((u) => u.role === "admin" && u.status === "active").length;
    if (adminCount <= 1) return false;
  }

  const filtered = store.filter((u) => u.id !== id);
  saveStore(filtered);
  return true;
}

/** Record the last login timestamp for a user (called on successful auth). */
export function setLastLogin(username: string): void {
  const store = loadStore();
  const user = store.find((u) => u.username === username);
  if (!user) return;
  user.last_login_at = new Date().toISOString();
  user.updated_at = new Date().toISOString();
  saveStore(store);
}
