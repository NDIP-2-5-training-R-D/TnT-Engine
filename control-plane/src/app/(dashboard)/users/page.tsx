"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  Users,
  UserPlus,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  Eye,
  EyeOff,
  AlertTriangle,
  X,
  Info,
} from "lucide-react";
import clsx from "clsx";

// ── Types ──────────────────────────────────────────────────────────

interface ManagedUser {
  id: string;
  username: string;
  role: "admin" | "manager" | "requester";
  displayName: string;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
  last_login_at?: string;
  created_by: string;
  force_password_change: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

function generatePassword(length = 16): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let result = "";
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

function formatDate(iso?: string): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Role Badge ─────────────────────────────────────────────────────

function RoleBadge({ role }: { role: ManagedUser["role"] }) {
  const styles: Record<ManagedUser["role"], string> = {
    admin: "bg-rose-500/15 text-rose-300 border border-rose-500/25",
    manager: "bg-blue-500/15 text-blue-300 border border-blue-500/25",
    requester: "bg-slate-700 text-slate-400 border border-slate-600",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
        styles[role]
      )}
    >
      {role}
    </span>
  );
}

// ── Status Dot ─────────────────────────────────────────────────────

function StatusDot({ status }: { status: ManagedUser["status"] }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={clsx(
          "w-2 h-2 rounded-full",
          status === "active" ? "bg-emerald-400" : "bg-slate-600"
        )}
      />
      <span className="text-xs text-slate-400 capitalize">{status}</span>
    </span>
  );
}

// ── Copy Button ────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── Reset Password Modal ───────────────────────────────────────────

interface ResetPasswordModalProps {
  user: ManagedUser;
  onClose: () => void;
  onSuccess: () => void;
}

function ResetPasswordModal({ user, onClose, onSuccess }: ResetPasswordModalProps) {
  const [tempPassword] = useState(() => generatePassword(16));
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const handleReset = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: tempPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to reset password");
      } else {
        setDone(true);
        onSuccess();
      }
    } catch {
      setError("Network error — please try again");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-white">Reset Password</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-slate-400 mb-4">
          Resetting password for{" "}
          <span className="font-mono text-white">{user.username}</span> (
          {user.displayName})
        </p>

        {!done ? (
          <>
            {/* Temp password display */}
            <div className="mb-4">
              <p className="text-xs text-slate-500 mb-1.5">Temporary password (shown once):</p>
              <div className="flex items-center gap-2 p-3 bg-slate-800 border border-slate-600 rounded-lg">
                <code className="flex-1 font-mono text-sm text-emerald-300 break-all">
                  {showPassword ? tempPassword : "•".repeat(tempPassword.length)}
                </code>
                <button
                  onClick={() => setShowPassword((v) => !v)}
                  className="p-1.5 text-slate-400 hover:text-white transition-colors"
                  title={showPassword ? "Hide password" : "Reveal password"}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <CopyButton text={tempPassword} />
              </div>
            </div>

            {/* Notice */}
            <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-5">
              <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-300">
                The user will be required to change this password on next login.
                Copy it now — it will not be shown again.
              </p>
            </div>

            {error && (
              <p className="text-xs text-rose-400 mb-3 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                {error}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 rounded-lg bg-slate-800 border border-slate-600 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm text-white font-medium disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {loading ? "Resetting..." : "Confirm Reset"}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-4">
            <Check className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
            <p className="text-sm text-white font-medium mb-1">Password reset successfully</p>
            <p className="text-xs text-slate-400 mb-5">
              Make sure you have copied the temporary password.
            </p>
            <button
              onClick={onClose}
              className="px-6 py-2 rounded-lg bg-slate-700 text-sm text-slate-300 hover:bg-slate-600 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add User Inline Form ───────────────────────────────────────────

interface AddUserFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

function AddUserForm({ onSuccess, onCancel }: AddUserFormProps) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<ManagedUser["role"]>("requester");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateUsername = (val: string) => {
    if (!val) return;
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(val)) {
      setUsernameError(
        "3-30 chars, letters/numbers/underscore/hyphen only"
      );
    } else {
      setUsernameError(null);
    }
  };

  const handleGeneratePassword = () => {
    const p = generatePassword(16);
    setPassword(p);
    setShowPassword(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (usernameError) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role, displayName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create user");
      } else {
        onSuccess();
      }
    } catch {
      setError("Network error — please try again");
    }
    setLoading(false);
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 mb-6">
      <h3 className="text-sm font-semibold text-white mb-4">New User</h3>
      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Display Name */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Display Name</label>
          <input
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Jane Smith"
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-slate-400"
          />
        </div>

        {/* Username */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Username</label>
          <input
            required
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              validateUsername(e.target.value);
            }}
            placeholder="e.g. jane_smith"
            className={clsx(
              "w-full px-3 py-2 bg-slate-900 border rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none",
              usernameError
                ? "border-rose-500 focus:border-rose-400"
                : "border-slate-600 focus:border-slate-400"
            )}
          />
          {usernameError && (
            <p className="text-xs text-rose-400 mt-1">{usernameError}</p>
          )}
        </div>

        {/* Role */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as ManagedUser["role"])}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-slate-400"
          >
            <option value="requester">requester</option>
            <option value="manager">manager</option>
            <option value="admin">admin</option>
          </select>
        </div>

        {/* Password */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Password</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                required
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Set a password"
                className="w-full px-3 py-2 pr-8 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-slate-400"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <button
              type="button"
              onClick={handleGeneratePassword}
              className="px-2.5 py-2 bg-slate-700 border border-slate-600 rounded-lg text-xs text-slate-300 hover:bg-slate-600 transition-colors whitespace-nowrap"
            >
              Auto-generate
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="md:col-span-2">
            <p className="text-xs text-rose-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="md:col-span-2 flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-slate-700 border border-slate-600 text-sm text-slate-300 hover:bg-slate-600 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !!usernameError}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm text-white font-medium disabled:opacity-50 transition-colors"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loading ? "Creating..." : "Create User"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── User Row ───────────────────────────────────────────────────────

interface UserRowProps {
  user: ManagedUser;
  currentUserId: string;
  onRoleChange: (id: string, role: ManagedUser["role"]) => Promise<void>;
  onDeactivate: (id: string) => Promise<void>;
  onResetPassword: (user: ManagedUser) => void;
  actionLoading: string | null;
}

function UserRow({
  user,
  currentUserId,
  onRoleChange,
  onDeactivate,
  onResetPassword,
  actionLoading,
}: UserRowProps) {
  const isSelf = user.id === currentUserId;
  const isLoading = actionLoading === user.id;

  return (
    <tr className="border-t border-slate-700/50 hover:bg-slate-800/30 transition-colors">
      {/* Status */}
      <td className="px-4 py-3">
        <StatusDot status={user.status} />
      </td>

      {/* Name + username */}
      <td className="px-4 py-3">
        <div className="text-sm text-white font-medium">{user.displayName}</div>
        <div className="font-mono text-xs text-slate-500">{user.username}</div>
        {user.force_password_change && (
          <span className="text-[10px] text-amber-400">pw change required</span>
        )}
        {isSelf && (
          <span className="ml-1 text-[10px] text-slate-600">(you)</span>
        )}
      </td>

      {/* Role */}
      <td className="px-4 py-3">
        <RoleBadge role={user.role} />
      </td>

      {/* Created At */}
      <td className="px-4 py-3 text-xs text-slate-500">
        {formatDate(user.created_at)}
      </td>

      {/* Last Login */}
      <td className="px-4 py-3 text-xs text-slate-500">
        {formatDate(user.last_login_at)}
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Edit Role dropdown */}
          <select
            value={user.role}
            disabled={isSelf || isLoading}
            onChange={(e) =>
              onRoleChange(user.id, e.target.value as ManagedUser["role"])
            }
            className="px-2 py-1 bg-slate-800 border border-slate-600 rounded text-xs text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:border-slate-400"
            title={isSelf ? "Cannot change your own role" : "Edit role"}
          >
            <option value="requester">requester</option>
            <option value="manager">manager</option>
            <option value="admin">admin</option>
          </select>

          {/* Deactivate button */}
          <button
            disabled={isSelf || isLoading || user.status === "inactive"}
            onClick={() => onDeactivate(user.id)}
            className={clsx(
              "px-2.5 py-1 rounded text-xs border transition-colors",
              "bg-slate-700/50 border-slate-600 text-slate-300",
              "hover:bg-slate-700 hover:text-white",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
            title={
              isSelf
                ? "Cannot deactivate yourself"
                : user.status === "inactive"
                ? "Already inactive"
                : "Deactivate user"
            }
          >
            {isLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              "Deactivate"
            )}
          </button>

          {/* Reset Password button */}
          <button
            onClick={() => onResetPassword(user)}
            disabled={isLoading}
            className={clsx(
              "px-2.5 py-1 rounded text-xs border transition-colors",
              "bg-blue-500/10 border-blue-500/25 text-blue-300",
              "hover:bg-blue-500/20",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
            title="Reset password"
          >
            Reset Pwd
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Main Page ──────────────────────────────────────────────────────

export default function UsersPage() {
  const { data: session } = useSession();
  const currentUserId = (session?.user as Record<string, unknown>)?.id as string ?? "";
  const currentRole = (session?.user as Record<string, unknown>)?.role as string ?? "";

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [externalProvider, setExternalProvider] = useState<false | string>(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Only admins can access this page
  const isAdmin = currentRole === "admin";

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/users");
      if (res.status === 401 || res.status === 403) {
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.managed === false) {
        // LDAP or OIDC
        const providerLabel = data.message?.includes("LDAP") ? "LDAP" : "OIDC";
        setExternalProvider(providerLabel);
      } else if (data.users) {
        setUsers(data.users);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleRoleChange = async (id: string, role: ManagedUser["role"]) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === id ? { ...u, ...data.user } : u))
        );
        showToast("success", "Role updated");
      } else {
        showToast("error", data.error || "Failed to update role");
      }
    } catch {
      showToast("error", "Network error");
    }
    setActionLoading(null);
  };

  const handleDeactivate = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permanent: false }),
      });
      const data = await res.json();
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === id ? { ...u, status: "inactive" } : u))
        );
        showToast("success", "User deactivated");
      } else {
        showToast("error", data.error || "Failed to deactivate user");
      }
    } catch {
      showToast("error", "Network error");
    }
    setActionLoading(null);
  };

  const handleAddSuccess = () => {
    setShowAddForm(false);
    showToast("success", "User created successfully");
    fetchUsers();
  };

  // ── 403 guard ─────────────────────────────────────────────────────

  if (!loading && !isAdmin) {
    return (
      <div className="max-w-xl mx-auto mt-20 text-center">
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-10">
          <AlertTriangle className="w-10 h-10 text-rose-400 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-white mb-2">Access Denied</h1>
          <p className="text-slate-400 text-sm">
            User Management is restricted to <span className="text-rose-300 font-medium">admin</span> accounts only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl">
      {/* Toast */}
      {toast && (
        <div
          className={clsx(
            "fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border text-sm shadow-lg flex items-center gap-2",
            toast.type === "success"
              ? "bg-emerald-900/80 border-emerald-700 text-emerald-200"
              : "bg-rose-900/80 border-rose-700 text-rose-200"
          )}
        >
          {toast.type === "success" ? (
            <Check className="w-4 h-4" />
          ) : (
            <AlertTriangle className="w-4 h-4" />
          )}
          {toast.message}
        </div>
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onSuccess={() => {
            showToast("success", `Password reset for ${resetTarget.username}`);
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Users className="w-6 h-6 text-slate-300" />
          <div>
            <h1 className="text-xl font-bold text-white">User Management</h1>
            <p className="text-xs text-slate-500">Control Plane access control</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchUsers}
            className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && !externalProvider && (
            <button
              onClick={() => setShowAddForm((v) => !v)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium transition-colors"
            >
              <UserPlus className="w-4 h-4" />
              Add User
            </button>
          )}
        </div>
      </div>

      {/* External provider notice */}
      {externalProvider && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-blue-500/20 bg-blue-500/5 mb-6">
          <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-blue-300 font-medium">
              Users are managed by {externalProvider}. This page is read-only.
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              To add, modify, or remove users, use your {externalProvider} administration tools.
            </p>
          </div>
        </div>
      )}

      {/* Add User Form */}
      {showAddForm && !externalProvider && (
        <AddUserForm
          onSuccess={handleAddSuccess}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 overflow-hidden">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 border-b border-slate-700/50 bg-slate-800/20 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Users table */}
      {!loading && !externalProvider && (
        <div className="rounded-xl border border-slate-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/80">
              <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Last Login</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-slate-500"
                  >
                    No users found
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    currentUserId={currentUserId}
                    onRoleChange={handleRoleChange}
                    onDeactivate={handleDeactivate}
                    onResetPassword={setResetTarget}
                    actionLoading={actionLoading}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Read-only table for external providers */}
      {!loading && externalProvider && users.length > 0 && (
        <div className="rounded-xl border border-slate-700 overflow-x-auto opacity-75">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/80">
              <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Last Login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-t border-slate-700/50"
                >
                  <td className="px-4 py-3">
                    <StatusDot status={user.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-white font-medium">
                      {user.displayName}
                    </div>
                    <div className="font-mono text-xs text-slate-500">
                      {user.username}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatDate(user.created_at)}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {formatDate(user.last_login_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary footer */}
      {!loading && users.length > 0 && (
        <div className="mt-3 flex items-center gap-4 text-xs text-slate-600">
          <span>{users.length} total user{users.length !== 1 ? "s" : ""}</span>
          <span>
            {users.filter((u) => u.status === "active").length} active
          </span>
          <span>
            {users.filter((u) => u.role === "admin").length} admin
            {users.filter((u) => u.role === "admin").length !== 1 ? "s" : ""}
          </span>
          <span>
            {users.filter((u) => u.role === "manager").length} manager
            {users.filter((u) => u.role === "manager").length !== 1 ? "s" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
