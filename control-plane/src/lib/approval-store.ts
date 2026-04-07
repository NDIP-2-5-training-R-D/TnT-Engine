/**
 * Maker-Checker Approval Queue — in-memory store with file persistence.
 *
 * Workflow:
 *   1. User A requests a sensitive action (seal, rotate, delete) → status: "pending"
 *   2. User B (different user, admin role) reviews and approves/rejects
 *   3. If approved, the system executes the action against OpenBao
 *   4. If rejected, the request is archived with reason
 *
 * Constraints:
 *   - Requester CANNOT approve their own request (enforced)
 *   - Only "admin" role can approve/reject
 *   - Pending requests expire after 1 hour
 *   - Actions requiring approval: SEAL, KEY_ROTATE, KEY_DELETE, POLICY_DELETE
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "expired";
export type ApprovalAction = "SEAL" | "KEY_ROTATE" | "KEY_DELETE" | "POLICY_DELETE";

export interface ApprovalRequest {
  id: string;
  action: ApprovalAction;
  target: string;           // key name, policy name, or "vault"
  requested_by: string;     // username
  requested_by_role: string;
  reason: string;
  status: ApprovalStatus;
  reviewed_by?: string;
  review_reason?: string;
  created_at: string;
  reviewed_at?: string;
  executed_at?: string;
  expires_at: string;       // 1 hour from creation
}

const STORE_PATH = process.env.APPROVAL_STORE_PATH || "/tmp/tnt-approvals.json";
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// ── Store Operations ───────────────────────────────────────────────

function loadStore(): ApprovalRequest[] {
  try {
    if (existsSync(STORE_PATH)) {
      return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    }
  } catch { /* ignore parse errors */ }
  return [];
}

function saveStore(items: ApprovalRequest[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(items, null, 2));
}

function generateId(): string {
  return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ─────────────────────────────────────────────────────

/** Create a new pending approval request. */
export function createApproval(
  action: ApprovalAction,
  target: string,
  requestedBy: string,
  requestedByRole: string,
  reason: string
): ApprovalRequest {
  const now = new Date();
  const request: ApprovalRequest = {
    id: generateId(),
    action,
    target,
    requested_by: requestedBy,
    requested_by_role: requestedByRole,
    reason,
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + EXPIRY_MS).toISOString(),
  };

  const store = loadStore();
  store.push(request);
  saveStore(store);
  return request;
}

/** List all requests, optionally filtered by status. */
export function listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
  const store = loadStore();
  // Expire old pending requests
  const now = new Date();
  let modified = false;
  for (const req of store) {
    if (req.status === "pending" && new Date(req.expires_at) < now) {
      req.status = "expired";
      modified = true;
    }
  }
  if (modified) saveStore(store);

  return status ? store.filter((r) => r.status === status) : store;
}

/** Get a single request by ID. */
export function getApproval(id: string): ApprovalRequest | undefined {
  return listApprovals().find((r) => r.id === id);
}

/**
 * Approve or reject a pending request.
 * Returns the updated request or null if validation fails.
 *
 * Rules:
 *   - Cannot review own request (Maker ≠ Checker)
 *   - Only pending requests can be reviewed
 *   - Expired requests cannot be approved
 */
export function reviewApproval(
  id: string,
  reviewedBy: string,
  decision: "approved" | "rejected",
  reviewReason?: string
): { request: ApprovalRequest | null; error: string | null } {
  const store = loadStore();
  const idx = store.findIndex((r) => r.id === id);

  if (idx === -1) return { request: null, error: "Request not found" };

  const req = store[idx];

  if (req.status !== "pending") {
    return { request: null, error: `Request is already ${req.status}` };
  }

  if (new Date(req.expires_at) < new Date()) {
    req.status = "expired";
    saveStore(store);
    return { request: null, error: "Request has expired" };
  }

  if (req.requested_by === reviewedBy) {
    return { request: null, error: "Cannot approve/reject your own request (Maker-Checker rule)" };
  }

  req.status = decision;
  req.reviewed_by = reviewedBy;
  req.review_reason = reviewReason || "";
  req.reviewed_at = new Date().toISOString();
  saveStore(store);

  return { request: req, error: null };
}

/** Mark an approved request as executed. */
export function markExecuted(id: string): void {
  const store = loadStore();
  const req = store.find((r) => r.id === id);
  if (req && req.status === "approved") {
    req.status = "executed";
    req.executed_at = new Date().toISOString();
    saveStore(store);
  }
}

/** Count pending requests (for badge in sidebar). */
export function pendingCount(): number {
  return listApprovals("pending").length;
}
