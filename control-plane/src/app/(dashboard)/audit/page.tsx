"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { FileText, RefreshCw, Download, Filter, X, Shield, Wifi, WifiOff } from "lucide-react";
import clsx from "clsx";
import type { CpAuditEntry } from "@/lib/cp-audit";

// ── Types ──────────────────────────────────────────────────────────

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
  cp_entries: CpAuditEntry[];
  cp_count: number;
}

// ── Config ─────────────────────────────────────────────────────────

const ENGINE_ACTION_COLORS: Record<string, string> = {
  TOKENIZE: "text-vault-green",
  DETOKENIZE: "text-vault-blue",
  BATCH_TOKENIZE: "text-vault-green",
  BATCH_DETOKENIZE: "text-vault-blue",
  REVOKE: "text-vault-yellow",
  DELETE: "text-vault-red",
  REENCRYPT: "text-purple-400",
};

const CP_ACTION_COLORS: Record<string, string> = {
  KEY_ROTATE: "text-amber-400",
  SEAL: "text-red-400",
  UNSEAL: "text-emerald-400",
  POLICY_CREATE: "text-blue-400",
  APPROVAL_CREATE: "text-cyan-400",
  APPROVAL_REVIEW: "text-cyan-300",
  BACKUP_TRIGGER: "text-purple-400",
  APPROLE_SECRET_GEN: "text-orange-400",
  VAULT_INIT: "text-pink-400",
};

const ENGINE_ACTIONS = ["", "TOKENIZE", "DETOKENIZE", "BATCH_TOKENIZE", "BATCH_DETOKENIZE", "REVOKE", "DELETE", "REENCRYPT"];

type Tab = "engine" | "cp";

// ── Component ──────────────────────────────────────────────────────

export default function AuditPage() {
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("engine");
  const [sseConnected, setSseConnected] = useState(false);
  const [liveEvents, setLiveEvents] = useState<CpAuditEntry[]>([]);

  // Engine filters
  const [tenant, setTenant] = useState("");
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(50);
  const [showFilters, setShowFilters] = useState(false);

  const esRef = useRef<EventSource | null>(null);

  // ── Data fetch (engine entries + CP entries from store) ──────────

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

  // Poll engine entries every 10s; CP entries come via SSE in real-time
  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 10_000);
    return () => clearInterval(t);
  }, [fetchData]);

  // ── SSE subscription for real-time CP events ─────────────────────

  useEffect(() => {
    const es = new EventSource("/api/events");
    esRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "CONNECTED") return;
        // Prepend live event to CP list (will be deduplicated on next fetch)
        const entry: CpAuditEntry = {
          id: `live_${Date.now()}`,
          action: event.type,
          performed_by: event.performed_by,
          role: "",
          target: event.target,
          result: event.result,
          detail: event.detail,
          performed_at: event.timestamp,
        };
        setLiveEvents((prev) => [entry, ...prev].slice(0, 100));
        // Refresh stored CP entries after a short delay (file write completes)
        setTimeout(fetchData, 500);
      } catch { /* ignore malformed */ }
    };

    return () => {
      es.close();
      setSseConnected(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived data ─────────────────────────────────────────────────

  // Merge stored CP entries with any live entries not yet persisted
  const cpEntries: CpAuditEntry[] = data?.cp_entries ?? liveEvents;

  const handleExport = (format: string) => {
    const params = new URLSearchParams();
    params.set("format", format);
    if (tenant) params.set("tenant", tenant);
    params.set("limit", "10000");
    window.open(`/api/audit/export?${params}`, "_blank");
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6 text-vault-blue" />
          <h1 className="text-xl font-bold text-white">Audit Log</h1>
          {/* SSE indicator */}
          <span className={clsx(
            "flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border",
            sseConnected
              ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
              : "text-slate-500 border-slate-700 bg-slate-800/50"
          )}>
            {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {sseConnected ? "Live" : "Offline"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Export buttons (engine entries) */}
          <div className="flex items-center gap-1 border border-slate-700 rounded-lg overflow-hidden">
            <button onClick={() => handleExport("cef")} className="px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white" title="Export CEF (Splunk/ArcSight)">
              <Download className="w-3 h-3 inline mr-1" />CEF
            </button>
            <button onClick={() => handleExport("json")} className="px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white border-x border-slate-700" title="Export ECS-JSON">
              JSON
            </button>
            <button onClick={() => handleExport("ndjson")} className="px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white" title="Export NDJSON">
              NDJSON
            </button>
          </div>
          {tab === "engine" && (
            <button onClick={() => setShowFilters(!showFilters)} className={clsx("p-2 rounded", showFilters ? "bg-slate-700 text-white" : "text-slate-500 hover:text-white")}>
              <Filter className="w-4 h-4" />
            </button>
          )}
          <button onClick={fetchData} className="text-slate-500 hover:text-white"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Status cards */}
      {data && (
        <div className="grid grid-cols-4 gap-4 mb-4">
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
            <p className="text-xs text-slate-400">Engine Entries</p>
            <p className="text-xl font-mono font-bold text-white">{data.count}</p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400">CP Actions</p>
            <p className="text-xl font-mono font-bold text-white">{data.cp_count}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-800/50 rounded-xl border border-slate-700 p-1 w-fit">
        <button
          onClick={() => setTab("engine")}
          className={clsx("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
            tab === "engine" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
          )}
        >
          <FileText className="w-3.5 h-3.5" />
          T&T Engine
          {data && <span className="text-xs text-slate-500 ml-1">{data.count}</span>}
        </button>
        <button
          onClick={() => setTab("cp")}
          className={clsx("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
            tab === "cp" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
          )}
        >
          <Shield className="w-3.5 h-3.5" />
          Control Plane
          {cpEntries.length > 0 && <span className="text-xs bg-amber-500/20 text-amber-400 px-1.5 rounded ml-1">{cpEntries.length}</span>}
        </button>
      </div>

      {/* Engine filters */}
      {tab === "engine" && showFilters && (
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
              {ENGINE_ACTIONS.map((a) => <option key={a} value={a}>{a || "All actions"}</option>)}
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

      {/* ── T&T Engine entries table ──────────────────────────────── */}
      {tab === "engine" && (
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
                    <span className={clsx("font-mono font-medium", ENGINE_ACTION_COLORS[e.action] || "text-slate-300")}>{e.action}</span>
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
      )}

      {/* ── Control Plane audit entries table ─────────────────────── */}
      {tab === "cp" && (
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-slate-400">
              <tr>
                <th className="text-left px-4 py-3">Action</th>
                <th className="text-left px-4 py-3">Performed By</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Target</th>
                <th className="text-left px-4 py-3">Result</th>
                <th className="text-left px-4 py-3">Detail</th>
                <th className="text-left px-4 py-3">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {!cpEntries.length ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  No Control Plane actions recorded yet. Rotate a key, create a policy, or trigger a backup.
                </td></tr>
              ) : cpEntries.map((e) => (
                <tr key={e.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-2.5">
                    <span className={clsx("font-mono font-medium text-sm", CP_ACTION_COLORS[e.action] || "text-slate-300")}>{e.action}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-200 font-mono text-xs">{e.performed_by}</td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs">{e.role || "-"}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{e.target || "-"}</td>
                  <td className="px-4 py-2.5">
                    <span className={clsx("text-xs px-1.5 py-0.5 rounded",
                      e.result === "success" ? "bg-vault-green/10 text-vault-green" : "bg-vault-red/10 text-vault-red"
                    )}>{e.result}</span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 max-w-xs truncate">{e.detail || "-"}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{new Date(e.performed_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-600 mt-2 text-right">
        Engine entries: polling 10s · CP entries: {sseConnected ? "real-time via SSE" : "SSE disconnected — refresh manually"}
      </p>
    </div>
  );
}
