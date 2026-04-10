/**
 * Local user store for Control Plane authentication.
 *
 * In production, replace with LDAP/OIDC provider.
 * Passwords are bcrypt-hashed. Default users for dev:
 *   admin/admin123      — full access (seal, rotate, delete, policy, approve, manage users)
 *   manager/mgr123      — full access within namespace (rotate, backup, policy, approve, delete)
 *   requester/req123    — read-only + generate secrets, must request role assignments
 */

import type { Role } from "./types";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string; // bcrypt
  role: Role;
  displayName: string;
}

// bcrypt hashes generated for dev passwords
// admin123 → $2a$10$... | oper123 → $2a$10$... | view123 → $2a$10$...
// In dev mode, we use plaintext comparison as fallback if bcrypt fails
const USERS: UserRecord[] = [
  {
    id: "usr_admin_001",
    username: "admin",
    passwordHash: "$2a$10$rQZKQYGp7bVK0VzF.Kx3YOqhHW3nHE8nZJHv1UFyV0nBXsR9TjWG6", // admin123
    role: "admin",
    displayName: "System Admin",
  },
  {
    id: "usr_manager_001",
    username: "manager",
    passwordHash: "$2a$10$LN1E8kP0H7hW8QjV4NM5HeZxR0qKpO9L2z5E9X1s3sF4K7tDq8nWi", // mgr123
    role: "manager",
    displayName: "Namespace Manager",
  },
  {
    id: "usr_requester_001",
    username: "requester",
    passwordHash: "$2a$10$9fZ0rLJK1hqW5Q8X3vT7aegHN0xJ2sV4F6pB0m7cR1kE8n5Y3wUdS", // req123
    role: "requester",
    displayName: "Service Requester",
  },
];

export function findUserByUsername(username: string): UserRecord | undefined {
  return USERS.find((u) => u.username === username);
}

export function findUserById(id: string): UserRecord | undefined {
  return USERS.find((u) => u.id === id);
}

// Dev-mode password check (plain comparison fallback if bcrypt hash doesn't match)
const DEV_PASSWORDS: Record<string, string> = {
  admin: "admin123",
  manager: "mgr123",
  requester: "req123",
};

export function verifyDevPassword(username: string, password: string): boolean {
  return DEV_PASSWORDS[username] === password;
}
