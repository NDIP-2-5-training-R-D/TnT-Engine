"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  KeyRound, RefreshCw, Filter, X, Search,
  ShieldOff, Trash2, CheckCircle, XCircle,
  Loader2, AlertTriangle, ChevronLeft, ChevronRight,
} from "lucide-react";
import clsx from "clsx";

// ── Types ──────────────────────────────────────────────────────────

interface TokenRecord {
  token: string;
  transformation: string;
  key_version: number;
  tenant_id: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TokensResponse {
  tokens: TokenRecord[];
  count: number;
  stats: Record<string, number>;
  offset: number;
  limit: number;
}

interface ActionResult { success: boolean; error?: string; revoked_by?: string; deleted_by?: string }

const STATUS_STYLE: Record<string, string> = {
  ACTIVE:  "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25",
  REVOKED: "bg-amber-500/15 text-amber-400 border border-amber-500/25",
  EXPIRED: "bg-slate-500/15 text-slate-400 border border-slate-500/25",
};

const TRANSFORM_COLOR: Record<string, string> = {
  TOKENIZE: "text-emerald-400",
  MASK:     "text-blue-400",
  HMAC:     "text-cyan-400",
};

const PAGE_SIZE = 50;

// ── Confirm modal ──────────────────────────────────────────────────

function ConfirmModal({
  token, action, tenantId, onConfirm, onCancel, loading,
}: {
  token: string;
  action: "revoke" | "delete";
  tenantId: string;
  onConfirm: (phrase: string) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [phrase, setPhrase] = useState("");
  const required = action === "delete" ? "DELETE" : "";
  const canProceed = action === "revoke" || phrase === required;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 max-w-md w-full shadow-2xl">
        <div className="flex items-center gap-2 mb-4">
          {action === "delete"
            ? <Trash2 className="w-5 h-5 text-red-400" />
            : <ShieldOff className="w-5 h-5 text-amber-400" />}
          <h3 className="font-semibold text-white capitalize">{action} Token</h3>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 mb-4">
          <p className="text-xs text-slate-500 mb-1">Token</p>
          <p className="font-mono text-xs text-slate-200 break-all">{token}</p>
          <p className="text-xs text-slate-500 mt-1">Tenant: <span className="text-slate-300">{tenantId}</span></p>
        </div>

        {action === "delete" ? (
          <>
            <div className="flex items-start gap-2 text-xs text-red-300 px-3 py-2 bg-red-500/10 rounded-lg border border-red-500/20 mb-4">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Hard delete is permanent. The token cannot be recovered or detokenized after deletion.
            </div>
            <div className="mb-4">
              <label className="text-xs text-slate-400 block mb-1.5">
                Type <code className="font-mono text-red-300">DELETE</code> to confirm
              </label>
              <input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm font-mono text-white focus:outline-none focus:ring-1 focus:ring-red-500"
              />
            </div>
          </>
        ) : (
          <div className="flex items-start gap-2 text-xs text-amber-300 px-3 py-2 bg-amber-500/10 rounded-lg border border-amber-500/20 mb-4">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            Revoke marks the token as REVOKED. It can no longer be detokenized but the record stays in the DB.
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-slate-400 border border-slate-600 hover:bg-slate-700 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(phrase)}
            disabled={!canProceed || loading}
            className={clsx(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40",
              action === "delete"
                ? "bg-red-600/80 hover:bg-red-600 text-white"
                : "bg-amber-600/80 hover:bg-amber-600 text-white",
            )}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {action === "delete" ? "Delete Token" : "Revoke Token"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export default function TokensPage() {
  const { data: session } = useSession();
  const role     = (session?.user as { role?: string })?.role ?? "requester";
  const isAdmin  = role === "admin";
  const canWrite = isAdmin || role === "manager";

  // Data state
  const [data, setData]     = useState<TokensResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset]   = useState(0);

  // Filters
  const [tenant,         setTenant]         = useState("");
  const [status,         setStatus]         = useState("");
  const [transformation, setTransformation] = useState("");
  const [showFilters,    setShowFilters]    = useState(false);
  const [search,         setSearch]         = useState("");

  // Action modal state
  const [modal, setModal] = useState<{ token: TokenRecord; action: "revoke" | "delete" } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult,  setActionResult]  = useState<{ token: string; result: ActionResult } | null>(null);

  const fetchData = useCallback(async (off = offset) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tenant)         params.set("tenant_id", tenant);
      if (status)         params.set("status", status);
      if (transformation) params.set("transformation", transformation);
      params.set("limit",  String(PAGE_SIZE));
      params.set("offset", String(off));
      const res = await fetch(`/api/tokens?${params}`);
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, [tenant, status, transformation, offset]);

  useEffect(() => { fetchData(0); setOffset(0); }, [tenant, status, transformation]);
  useEffect(() => { fetchData(offset); }, [offset]);

  const handleAction = async (phrase: string) => {
    if (!modal) return;
    setActionLoading(true);
    const url = modal.action === "revoke" ? "/api/tokens/revoke" : "/api/tokens/delete";
    const body: Record<string, string> = { token: modal.token.token, tenant_id: modal.token.tenant_id };
    if (modal.action === "delete") body.confirm = phrase;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: ActionResult = await res.json();
      setActionResult({ token: modal.token.token, result });
      setModal(null);
      if (result.success) fetchData(offset);
    } catch {
      setActionResult({ token: modal.token.token, result: { success: false, error: "Network error" } });
    }
    setActionLoading(false);
  };

  // Client-side token search filter
  const displayed = (data?.tokens ?? []).filter((t) =>
    !search || t.token.includes(search) || t.tenant_id.includes(search),
  );

  const totalPages = data ? Math.ceil((data.count + data.offset) / PAGE_SIZE) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <KeyRound className="w-6 h-6 text-indigo-400" />
          <h1 className="text-xl font-bold text-white">Token Lifecycle</h1>
          {data?.stats && (
            <div className="flex items-center gap-2">
              {Object.entries(data.stats).map(([s, n]) => (
                <span key={s} className={clsx("text-xs px-2 py-0.5 rounded-full font-medium", STATUS_STYLE[s] ?? "bg-slate-700 text-slate-400")}>
                  {n} {s}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowFilters((v) => !v)} className={clsx("p-1.5 rounded-lg text-sm transition-colors", showFilters ? "bg-slate-700 text-white" : "text-slate-500 hover:text-white hover:bg-slate-700")}>
            <Filter className="w-4 h-4" />
          </button>
          <button onClick={() => fetchData(offset)} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-400 mb-4">
        View and manage token lifecycle — revoke active tokens or hard-delete records.
        No plaintext values are shown.
      </p>

      {/* Action result toast */}
      {actionResult && (
        <div className={clsx(
          "flex items-center gap-3 px-4 py-2.5 rounded-xl border mb-4 text-sm",
          actionResult.result.success
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
            : "border-red-500/25 bg-red-500/10 text-red-300",
        )}>
          {actionResult.result.success
            ? <CheckCircle className="w-4 h-4 shrink-0" />
            : <XCircle className="w-4 h-4 shrink-0" />}
          <span className="flex-1">
            {actionResult.result.success
              ? `Token ${actionResult.token.slice(0, 12)}… successfully processed.`
              : actionResult.result.error}
          </span>
          <button onClick={() => setActionResult(null)} className="text-xs opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Filters */}
      {showFilters && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 mb-4 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-36">
            <label className="text-xs text-slate-400 block mb-1">Tenant ID</label>
            <input value={tenant} onChange={(e) => setTenant(e.target.value)}
              placeholder="All tenants" className="w-full px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm text-white font-mono focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm text-white focus:outline-none">
              <option value="">All</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="REVOKED">REVOKED</option>
              <option value="EXPIRED">EXPIRED</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Transformation</label>
            <select value={transformation} onChange={(e) => setTransformation(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm text-white focus:outline-none">
              <option value="">All</option>
              <option value="TOKENIZE">TOKENIZE</option>
              <option value="MASK">MASK</option>
              <option value="HMAC">HMAC</option>
            </select>
          </div>
          {(tenant || status || transformation) && (
            <button onClick={() => { setTenant(""); setStatus(""); setTransformation(""); }}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-white">
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      {/* Search bar */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by token prefix or tenant…"
          className="w-full pl-9 pr-4 py-2 bg-slate-800/50 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-600 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
        {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>}
      </div>

      {/* Token table */}
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-3">Token</th>
              <th className="text-left px-4 py-3">Tenant</th>
              <th className="text-left px-4 py-3">Transform</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Key Ver</th>
              <th className="text-left px-4 py-3">Created</th>
              <th className="text-left px-4 py-3">Expires</th>
              {canWrite && <th className="text-left px-4 py-3">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {loading && !data ? (
              <tr><td colSpan={canWrite ? 8 : 7} className="px-4 py-10 text-center text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin mx-auto" />
              </td></tr>
            ) : displayed.length === 0 ? (
              <tr><td colSpan={canWrite ? 8 : 7} className="px-4 py-10 text-center text-slate-500">
                No tokens found. Adjust filters or perform tokenize operations.
              </td></tr>
            ) : displayed.map((t) => (
              <tr key={t.token} className="hover:bg-slate-800/30 transition-colors group">
                <td className="px-4 py-2.5 font-mono text-xs text-indigo-300">
                  {t.token.slice(0, 16)}…
                  <span className="text-slate-600 text-[10px] ml-1">{t.token.slice(-4)}</span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{t.tenant_id}</td>
                <td className="px-4 py-2.5">
                  <span className={clsx("font-mono text-xs font-medium", TRANSFORM_COLOR[t.transformation] ?? "text-slate-300")}>
                    {t.transformation}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={clsx("text-xs px-2 py-0.5 rounded-full font-medium", STATUS_STYLE[t.status] ?? "bg-slate-700 text-slate-300")}>
                    {t.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500">v{t.key_version}</td>
                <td className="px-4 py-2.5 text-xs text-slate-400">{new Date(t.created_at).toLocaleString()}</td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {t.expires_at ? new Date(t.expires_at).toLocaleString() : "—"}
                </td>
                {canWrite && (
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {t.status === "ACTIVE" && (
                        <button
                          onClick={() => setModal({ token: t, action: "revoke" })}
                          title="Revoke"
                          className="p-1.5 rounded-lg text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
                        >
                          <ShieldOff className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          onClick={() => setModal({ token: t, action: "delete" })}
                          title="Hard delete"
                          className="p-1.5 rounded-lg text-red-400/70 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.count >= PAGE_SIZE && (
        <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
          <span>Page {currentPage} · {data.count} tokens in this page</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="p-1.5 rounded-lg hover:bg-slate-700 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span>Page {currentPage}</span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={data.count < PAGE_SIZE}
              className="p-1.5 rounded-lg hover:bg-slate-700 disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {modal && (
        <ConfirmModal
          token={modal.token.token}
          action={modal.action}
          tenantId={modal.token.tenant_id}
          onConfirm={handleAction}
          onCancel={() => setModal(null)}
          loading={actionLoading}
        />
      )}
    </div>
  );
}
