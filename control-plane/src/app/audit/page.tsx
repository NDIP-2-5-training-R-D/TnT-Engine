"use client";

import { useState, useEffect, useCallback } from "react";
import { FileText, RefreshCw, Download, Filter, X } from "lucide-react";
import clsx from "clsx";

interface AuditEntry {
  id: number;
  action: string;
  field: string | null;
  tenant_id: string;
  trace_id: string | null;
  status: string;
  performed_at: string;
  metadata: string;
}

interface AuditData {
  buffer_size: number;
  dlq_size_bytes: number;
  entries: AuditEntry[];
  count: number;
}

const ACTION_COLORS: Record<string, string> = {
  TOKENIZE: "text-vault-green",
  DETOKENIZE: "text-vault-blue",
  BATCH_TOKENIZE: "text-vault-green",
  BATCH_DETOKENIZE: "text-vault-blue",
  REVOKE: "text-vault-yellow",
  DELETE: "text-vault-red",
  REENCRYPT: "text-purple-400",
};

const ACTIONS = ["", "TOKENIZE", "DETOKENIZE", "BATCH_TOKENIZE", "BATCH_DETOKENIZE", "REVOKE", "DELETE", "REENCRYPT"];

export default function AuditPage() {
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [tenant, setTenant] = useState("");
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(50);
  const [showFilters, setShowFilters] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", limit.toString());
      if (tenant) params.set("tenant", tenant);
      if (action) params.set("action", action);

      const res = await fetch(`/api/audit?${params}`);
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, [tenant, action, limit]);

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 10_000); return () => clearInterval(t); }, [fetchData]);

  const handleExport = (format: string) => {
    const params = new URLSearchParams();
    params.set("format", format);
    if (tenant) params.set("tenant", tenant);
    params.set("limit", "10000");
    window.open(`/api/audit/export?${params}`, "_blank");
  };

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-vault-blue" />
          <h1 className="text-xl font-bold text-white">Audit Log</h1>
          {data && <span className="text-xs text-slate-500">{data.count} entries</span>}
        </div>
        <div className="flex items-center gap-2">
          {/* Export buttons */}
          <div className="flex items-center gap-1 border border-slate-700 rounded-lg overflow-hidden">
            <button onClick={() => handleExport("cef")} className="px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white" title="Export CEF (Splunk/ArcSight)">
              <Download className="w-3 h-3 inline mr-1" />CEF
            </button>
            <button onClick={() => handleExport("json")} className="px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white border-x border-slate-700" title="Export ECS-JSON (Elasticsearch)">
              JSON
            </button>
            <button onClick={() => handleExport("ndjson")} className="px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white" title="Export NDJSON (Elastic bulk)">
              NDJSON
            </button>
          </div>
          <button onClick={() => setShowFilters(!showFilters)} className={clsx("p-2 rounded", showFilters ? "bg-slate-700 text-white" : "text-slate-500 hover:text-white")}>
            <Filter className="w-4 h-4" />
          </button>
          <button onClick={fetchData} className="text-slate-500 hover:text-white"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Status cards */}
      {data && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400">Buffer</p>
            <p className="text-xl font-mono font-bold text-white">{data.buffer_size}</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400">DLQ Size</p>
            <p className="text-xl font-mono font-bold text-white">
              {data.dlq_size_bytes > 0 ? `${(data.dlq_size_bytes / 1024).toFixed(1)} KB` : "0 B"}
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400">Entries Shown</p>
            <p className="text-xl font-mono font-bold text-white">{data.count}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      {showFilters && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 mb-4 flex gap-4 items-end">
          <div className="flex-1">
            <label className="text-xs text-slate-400 block mb-1">Tenant ID</label>
            <input value={tenant} onChange={(e) => setTenant(e.target.value)}
              placeholder="All tenants" className="w-full px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm text-white font-mono focus:outline-none" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Action</label>
            <select value={action} onChange={(e) => setAction(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm text-white focus:outline-none">
              {ACTIONS.map((a) => <option key={a} value={a}>{a || "All actions"}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Limit</label>
            <select value={limit} onChange={(e) => setLimit(+e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm text-white focus:outline-none">
              {[20, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {(tenant || action) && (
            <button onClick={() => { setTenant(""); setAction(""); }} className="text-xs text-slate-500 hover:text-white flex items-center gap-1">
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      {/* Entries table */}
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3 w-10">#</th>
              <th className="text-left px-4 py-3">Action</th>
              <th className="text-left px-4 py-3">Field</th>
              <th className="text-left px-4 py-3">Tenant</th>
              <th className="text-left px-4 py-3">Trace ID</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {loading && !data ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Loading...</td></tr>
            ) : !data?.entries?.length ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                No audit entries found. Perform tokenize/detokenize operations to generate entries.
              </td></tr>
            ) : data.entries.map((e) => (
              <tr key={e.id} className="hover:bg-slate-800/30">
                <td className="px-4 py-2 text-xs text-slate-600 font-mono">{e.id}</td>
                <td className="px-4 py-2">
                  <span className={clsx("font-mono font-medium", ACTION_COLORS[e.action] || "text-slate-300")}>{e.action}</span>
                </td>
                <td className="px-4 py-2 text-slate-300">{e.field || "-"}</td>
                <td className="px-4 py-2 text-slate-400 font-mono text-xs">{e.tenant_id}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{e.trace_id ? e.trace_id.slice(0, 12) + "..." : "-"}</td>
                <td className="px-4 py-2">
                  <span className={clsx("text-xs px-1.5 py-0.5 rounded",
                    e.status === "success" ? "bg-vault-green/10 text-vault-green" : "bg-vault-red/10 text-vault-red"
                  )}>{e.status}</span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{new Date(e.performed_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-600 mt-2 text-right">Auto-refreshing every 10s</p>
    </div>
  );
}
