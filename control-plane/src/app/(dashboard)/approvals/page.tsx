"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { CheckCircle, XCircle, Clock, Shield, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import clsx from "clsx";

interface ApprovalRequest {
  id: string;
  action: string;
  target: string;
  requested_by: string;
  reason: string;
  status: string;
  reviewed_by?: string;
  review_reason?: string;
  created_at: string;
  reviewed_at?: string;
  expires_at: string;
}

const statusConfig: Record<string, { color: string; icon: typeof Clock }> = {
  pending:  { color: "text-vault-yellow border-vault-yellow/30", icon: Clock },
  approved: { color: "text-vault-green border-vault-green/30", icon: CheckCircle },
  rejected: { color: "text-vault-red border-vault-red/30", icon: XCircle },
  executed: { color: "text-slate-400 border-slate-600", icon: CheckCircle },
  expired:  { color: "text-slate-600 border-slate-700", icon: Clock },
};

export default function ApprovalsPage() {
  const { data: session } = useSession();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const currentUser = (session?.user as any)?.username || "";
  const currentRole = (session?.user as any)?.role || "viewer";

  const fetchRequests = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (res.ok) setRequests(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRequests(); const t = setInterval(fetchRequests, 5000); return () => clearInterval(t); }, [fetchRequests]);

  const handleReview = async (id: string, decision: "approved" | "rejected") => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "review", id, decision, review_reason: reviewReason }),
      });
      const data = await res.json();
      if (data.success) { setReviewingId(null); setReviewReason(""); fetchRequests(); }
    } catch { /* ignore */ }
    setActionLoading(false);
  };

  const pendingRequests = requests.filter((r) => r.status === "pending");
  const historyRequests = requests.filter((r) => r.status !== "pending");

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-vault-yellow" />
          <h1 className="text-xl font-bold text-white">Approval Queue</h1>
          {pendingRequests.length > 0 && (
            <span className="px-2 py-0.5 bg-vault-yellow/20 rounded-full text-xs text-vault-yellow font-mono">
              {pendingRequests.length} pending
            </span>
          )}
        </div>
        <button onClick={fetchRequests} className="text-slate-500 hover:text-white"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {/* Pending Requests */}
      <h2 className="text-sm font-semibold text-slate-400 mb-3">Pending Approval</h2>
      {loading ? (
        <div className="text-center py-8 text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : pendingRequests.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-6 text-center text-slate-500 mb-6">
          No pending requests
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {pendingRequests.map((req) => {
            const cfg = statusConfig[req.status] || statusConfig.pending;
            const Icon = cfg.icon;
            const canReview = currentRole === "admin" && req.requested_by !== currentUser;
            const isReviewing = reviewingId === req.id;

            return (
              <div key={req.id} className={clsx("rounded-xl border bg-slate-800/50 p-4", cfg.color)}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="w-5 h-5" />
                    <span className="font-mono font-bold text-white">{req.action}</span>
                    <span className="text-slate-400">→</span>
                    <span className="font-mono text-slate-300">{req.target}</span>
                  </div>
                  <span className="text-xs text-slate-500">{new Date(req.created_at).toLocaleString()}</span>
                </div>
                <p className="text-sm text-slate-400 mb-1">Reason: <span className="text-slate-300">{req.reason}</span></p>
                <p className="text-xs text-slate-500">Requested by: <span className="text-slate-400">{req.requested_by}</span></p>

                {canReview && !isReviewing && (
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => setReviewingId(req.id)} className="px-3 py-1 bg-vault-green/20 border border-vault-green/40 rounded text-xs text-vault-green">Review</button>
                  </div>
                )}

                {canReview && isReviewing && (
                  <div className="mt-3 p-3 bg-slate-900 rounded-lg space-y-2">
                    <input value={reviewReason} onChange={(e) => setReviewReason(e.target.value)}
                      placeholder="Review comment (optional)" className="w-full px-3 py-1.5 bg-slate-800 border border-slate-600 rounded text-sm text-white focus:outline-none" />
                    <div className="flex gap-2">
                      <button onClick={() => handleReview(req.id, "approved")} disabled={actionLoading}
                        className="px-3 py-1 bg-vault-green/20 border border-vault-green/40 rounded text-xs text-vault-green disabled:opacity-50">
                        {actionLoading ? "..." : "Approve & Execute"}
                      </button>
                      <button onClick={() => handleReview(req.id, "rejected")} disabled={actionLoading}
                        className="px-3 py-1 bg-vault-red/20 border border-vault-red/40 rounded text-xs text-vault-red disabled:opacity-50">Reject</button>
                      <button onClick={() => setReviewingId(null)} className="px-3 py-1 bg-slate-700 rounded text-xs text-slate-400">Cancel</button>
                    </div>
                    {req.requested_by === currentUser && (
                      <p className="text-xs text-vault-red flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> You cannot review your own request</p>
                    )}
                  </div>
                )}

                {!canReview && currentRole !== "admin" && (
                  <p className="mt-2 text-xs text-slate-600">Only admins can approve/reject requests</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* History */}
      <h2 className="text-sm font-semibold text-slate-400 mb-3">History</h2>
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400">
            <tr>
              <th className="text-left px-4 py-2">Action</th>
              <th className="text-left px-4 py-2">Target</th>
              <th className="text-left px-4 py-2">Requester</th>
              <th className="text-left px-4 py-2">Reviewer</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {historyRequests.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">No history yet</td></tr>
            ) : historyRequests.slice(0, 20).map((req) => (
              <tr key={req.id} className="hover:bg-slate-800/30">
                <td className="px-4 py-2 font-mono">{req.action}</td>
                <td className="px-4 py-2 font-mono text-slate-300">{req.target}</td>
                <td className="px-4 py-2 text-slate-400">{req.requested_by}</td>
                <td className="px-4 py-2 text-slate-400">{req.reviewed_by || "-"}</td>
                <td className="px-4 py-2">
                  <span className={clsx("text-xs px-1.5 py-0.5 rounded",
                    req.status === "executed" ? "bg-vault-green/20 text-vault-green" :
                    req.status === "rejected" ? "bg-vault-red/20 text-vault-red" :
                    "bg-slate-700 text-slate-400"
                  )}>{req.status}</span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{new Date(req.reviewed_at || req.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
