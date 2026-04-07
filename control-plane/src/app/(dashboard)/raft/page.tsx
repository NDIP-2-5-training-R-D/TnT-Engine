"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  Network, RefreshCw, Loader2, AlertTriangle,
  CheckCircle, XCircle, ShieldAlert,
} from "lucide-react";
import clsx from "clsx";

// ── Types ──────────────────────────────────────────────────────────────────

interface RaftMember {
  id: string;
  address: string;
  voter: boolean;
  leader: boolean;
  healthy: boolean;
  last_contact?: string;
  node_status?: string;
}

interface RaftState {
  members: RaftMember[];
  cluster_name: string;
  cluster_id: string;
  leader_address: string;
  healthy: boolean;
  failure_tolerance: number;
  total_voters: number;
  source: "live" | "error";
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function RoleBadge({ member }: { member: RaftMember }) {
  if (member.leader) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/25">
        Leader
      </span>
    );
  }
  if (member.voter) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/15 text-blue-300 border border-blue-500/25">
        Voter
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-slate-700 text-slate-400 border border-slate-600">
      Non-voter
    </span>
  );
}

function StatusDot({ healthy }: { healthy: boolean }) {
  return (
    <span className="relative flex items-center gap-1.5">
      <span
        className={clsx(
          "inline-block w-2 h-2 rounded-full",
          healthy ? "bg-emerald-400" : "bg-red-400",
        )}
      />
      <span className={clsx("text-xs", healthy ? "text-emerald-300" : "text-red-300")}>
        {healthy ? "Healthy" : "Unhealthy"}
      </span>
    </span>
  );
}

// ── Inline confirm dialog ──────────────────────────────────────────────────

function RemoveConfirm({
  member,
  onConfirm,
  onCancel,
  removing,
}: {
  member: RaftMember;
  onConfirm: () => void;
  onCancel: () => void;
  removing: boolean;
}) {
  return (
    <div className="mt-2 mx-4 mb-2 rounded-xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-slate-300">
          Removing this node will reduce cluster fault tolerance.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-500">Node ID</span>
        <span className="font-mono text-slate-200 break-all">{member.id}</span>
        <span className="text-slate-500">Address</span>
        <span className="font-mono text-slate-200">{member.address}</span>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onConfirm}
          disabled={removing}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/80 hover:bg-red-600 rounded-lg text-white text-xs font-medium disabled:opacity-50 transition-colors"
        >
          {removing ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Removing…</>
          ) : (
            "Confirm Remove"
          )}
        </button>
        <button
          onClick={onCancel}
          disabled={removing}
          className="px-3 py-1.5 rounded-lg text-slate-400 text-xs border border-slate-600 hover:bg-slate-700 hover:text-white disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Members table ──────────────────────────────────────────────────────────

function MembersTable({
  members,
  isAdmin,
  onRemove,
}: {
  members: RaftMember[];
  isAdmin: boolean;
  onRemove: (member: RaftMember) => Promise<void>;
}) {
  const [confirmId, setConfirmId]   = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const handleConfirm = async (member: RaftMember) => {
    setRemovingId(member.id);
    setRemoveError(null);
    try {
      await onRemove(member);
      setConfirmId(null);
    } catch (err) {
      setRemoveError(String(err));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-slate-700 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-3">Status</th>
            <th className="text-left px-4 py-3">Node ID</th>
            <th className="text-left px-4 py-3">Address</th>
            <th className="text-left px-4 py-3">Role</th>
            <th className="text-left px-4 py-3">Last Contact</th>
            {isAdmin && <th className="text-left px-4 py-3">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/50">
          {members.length === 0 ? (
            <tr>
              <td colSpan={isAdmin ? 6 : 5} className="px-4 py-10 text-center text-slate-500">
                No cluster members found.
              </td>
            </tr>
          ) : members.map((m) => (
            <>
              <tr
                key={m.id}
                className={clsx(
                  "hover:bg-slate-800/30 transition-colors",
                  confirmId === m.id && "bg-slate-800/20",
                )}
              >
                {/* Status */}
                <td className="px-4 py-3">
                  <StatusDot healthy={m.healthy} />
                </td>

                {/* Node ID — monospace, truncated */}
                <td className="px-4 py-3">
                  <span
                    className="font-mono text-xs text-slate-200"
                    title={m.id}
                  >
                    {m.id.length > 12 ? `${m.id.slice(0, 12)}…` : m.id}
                  </span>
                </td>

                {/* Address */}
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-slate-300">{m.address}</span>
                </td>

                {/* Role badge */}
                <td className="px-4 py-3">
                  <RoleBadge member={m} />
                </td>

                {/* Last contact */}
                <td className="px-4 py-3 text-xs text-slate-400 font-mono">
                  {m.last_contact ?? (m.leader ? "0s" : "—")}
                </td>

                {/* Actions — admin only */}
                {isAdmin && (
                  <td className="px-4 py-3">
                    {m.leader ? (
                      <span
                        className="text-xs text-slate-600 cursor-not-allowed select-none"
                        title="Cannot remove leader"
                      >
                        Remove
                      </span>
                    ) : (
                      <button
                        onClick={() =>
                          setConfirmId(confirmId === m.id ? null : m.id)
                        }
                        disabled={removingId !== null}
                        className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 px-2.5 py-1 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>

              {/* Inline confirm expander */}
              {confirmId === m.id && (
                <tr key={`${m.id}-confirm`} className="bg-slate-900/60">
                  <td colSpan={isAdmin ? 6 : 5} className="p-0">
                    <RemoveConfirm
                      member={m}
                      removing={removingId === m.id}
                      onConfirm={() => handleConfirm(m)}
                      onCancel={() => { setConfirmId(null); setRemoveError(null); }}
                    />
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>

      {removeError && (
        <div className="px-4 py-3 border-t border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-300">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          {removeError}
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function RaftClusterPage() {
  const { data: session } = useSession();
  const [state, setState]     = useState<RaftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const role    = (session?.user as { role?: string })?.role ?? "viewer";
  const isAdmin = role === "admin";

  // ── Fetch ──────────────────────────────────────────────────────────
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/raft");
      if (res.ok) {
        const data: RaftState = await res.json();
        setState(data);
      } else {
        setState((prev) => prev
          ? { ...prev, source: "error", error: `HTTP ${res.status}` }
          : {
              members: [], cluster_name: "", cluster_id: "",
              leader_address: "", healthy: false, failure_tolerance: 0,
              total_voters: 0, source: "error", error: `HTTP ${res.status}`,
            });
      }
    } catch (err) {
      setState((prev) => prev
        ? { ...prev, source: "error", error: String(err) }
        : {
            members: [], cluster_name: "", cluster_id: "",
            leader_address: "", healthy: false, failure_tolerance: 0,
            total_voters: 0, source: "error", error: String(err),
          });
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  }, []);

  // Initial load
  useEffect(() => { fetchState(); }, [fetchState]);

  // Auto-refresh every 10 s
  useEffect(() => {
    const id = setInterval(fetchState, 10_000);
    return () => clearInterval(id);
  }, [fetchState]);

  // ── Remove peer ────────────────────────────────────────────────────
  const removePeer = async (member: RaftMember) => {
    const res = await fetch("/api/raft", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: member.id }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    // Refresh after successful removal
    await fetchState();
  };

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Network className="w-6 h-6 text-blue-400" />
          <div>
            <h1 className="text-xl font-bold text-white leading-tight">Raft Cluster</h1>
            <p className="text-xs text-slate-500 mt-0.5">OpenBao distributed consensus</p>
          </div>
          {state && !loading && (
            <span
              className={clsx(
                "text-xs px-2 py-0.5 rounded border font-medium",
                state.healthy
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/25"
                  : "bg-red-500/15 text-red-300 border-red-500/25",
              )}
            >
              {state.healthy ? "Healthy" : "Degraded"}
            </span>
          )}
        </div>
        <button
          onClick={fetchState}
          disabled={loading}
          title={lastRefresh ? `Last refreshed: ${lastRefresh.toLocaleTimeString()}` : undefined}
          className="p-1.5 rounded text-slate-500 hover:text-white transition-colors disabled:opacity-40"
        >
          <RefreshCw className={clsx("w-4 h-4", loading && "animate-spin")} />
        </button>
      </div>

      {/* ── Loading skeleton ────────────────────────────────────── */}
      {loading && !state && (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin mr-3" />
          <span className="text-sm">Connecting to OpenBao…</span>
        </div>
      )}

      {/* ── Error state ─────────────────────────────────────────── */}
      {!loading && state?.source === "error" && state.members.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 rounded-xl border border-slate-700 bg-slate-800/30">
          <ShieldAlert className="w-10 h-10 text-red-400" />
          <div className="text-center">
            <p className="text-white font-medium">Unable to connect to OpenBao</p>
            {state.error && (
              <p className="text-xs text-slate-500 mt-1 max-w-sm">{state.error}</p>
            )}
          </div>
          <button
            onClick={fetchState}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300 text-sm transition-colors mt-2"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      )}

      {/* ── Cluster data ────────────────────────────────────────── */}
      {state && (state.source === "live" || state.members.length > 0) && (
        <>
          {/* ── Health summary bar ──────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 mb-5 px-4 py-3 rounded-xl border border-slate-700 bg-slate-800/40">
            {/* Cluster name */}
            {state.cluster_name && (
              <div className="flex items-center gap-1.5 mr-2">
                <span className="text-xs text-slate-500">Cluster</span>
                <span className="text-xs font-mono text-slate-200">{state.cluster_name}</span>
              </div>
            )}

            {/* Separator */}
            {state.cluster_name && (
              <span className="hidden sm:block w-px h-4 bg-slate-700" />
            )}

            {/* Total members */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Members</span>
              <span className="text-sm font-semibold text-white">{state.members.length}</span>
            </div>

            <span className="w-px h-4 bg-slate-700" />

            {/* Voters */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Voters</span>
              <span className="text-sm font-semibold text-white">{state.total_voters}</span>
            </div>

            <span className="w-px h-4 bg-slate-700" />

            {/* Failure tolerance */}
            <span
              className={clsx(
                "text-xs px-2.5 py-1 rounded-full border font-medium",
                state.failure_tolerance > 0
                  ? "bg-blue-500/10 text-blue-300 border-blue-500/20"
                  : "bg-amber-500/10 text-amber-300 border-amber-500/20",
              )}
            >
              Tolerates {state.failure_tolerance} failure{state.failure_tolerance !== 1 ? "s" : ""}
            </span>

            {/* Health badge */}
            <span
              className={clsx(
                "text-xs px-2.5 py-1 rounded-full border font-medium flex items-center gap-1.5",
                state.healthy
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                  : "bg-red-500/10 text-red-300 border-red-500/20",
              )}
            >
              {state.healthy
                ? <CheckCircle className="w-3 h-3" />
                : <XCircle className="w-3 h-3" />}
              {state.healthy ? "Healthy" : "Degraded"}
            </span>

            {/* Partial error warning */}
            {state.source === "error" && state.error && (
              <span className="flex items-center gap-1.5 text-xs text-amber-400">
                <AlertTriangle className="w-3.5 h-3.5" />
                Partial data — {state.error}
              </span>
            )}
          </div>

          {/* ── Members table ────────────────────────────────────── */}
          {loading ? (
            <div className="rounded-xl border border-slate-700 bg-slate-800/30 flex items-center justify-center py-12 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">Refreshing…</span>
            </div>
          ) : (
            <MembersTable
              members={state.members}
              isAdmin={isAdmin}
              onRemove={removePeer}
            />
          )}

          {/* Auto-refresh indicator */}
          <p className="text-[11px] text-slate-600 mt-3 text-right">
            Auto-refreshes every 10s
            {lastRefresh && ` — last updated ${lastRefresh.toLocaleTimeString()}`}
          </p>
        </>
      )}
    </div>
  );
}
