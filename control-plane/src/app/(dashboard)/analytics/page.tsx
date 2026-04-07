"use client";

import useSWR from "swr";
import {
  BarChart2, RefreshCw, TrendingUp, AlertCircle,
  Zap, Database, ShieldCheck,
} from "lucide-react";
import clsx from "clsx";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────

interface AnalyticsData {
  requestBreakdown:  { name: string; total: number; errors: number }[];
  errorBreakdown:    { name: string; value: number }[];
  transformBreakdown:{ name: string; value: number }[];
  latencyBuckets:    { bucket: string; count: number }[];
  cryptoOps:         { operation: string; count: number }[];
  summary: {
    totalRequests:       number;
    totalErrors:         number;
    errorRate:           string;
    cacheHitPct:         number;
    vaultSealed:         boolean;
    auditBufferSize:     number;
    auditDlqBytes:       number;
    totalTokensCreated:  number;
  };
  fetched_at: string;
  error?: string;
}

// ── Chart colors ───────────────────────────────────────────────────

const PIE_COLORS = ["#34d399","#60a5fa","#f59e0b","#f87171","#a78bfa","#fb923c"];
const BAR_PRIMARY  = "#6366f1";
const BAR_ERROR    = "#f87171";
const BAR_CRYPTO   = "#34d399";
const BAR_LATENCY  = "#60a5fa";

// ── Helpers ────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function SummaryCard({ icon, label, value, sub, accent = "text-white" }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
      <div className="flex items-center gap-1.5 text-slate-400 text-xs mb-2">{icon}<span>{label}</span></div>
      <p className={clsx("text-2xl font-mono font-bold", accent)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { data, isLoading, mutate } = useSWR<AnalyticsData>("/api/analytics", fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
  });

  const s = data?.summary;

  return (
    <div className="max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <BarChart2 className="w-6 h-6 text-indigo-400" />
          <h1 className="text-xl font-bold text-white">Real-time Analytics</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/25">
            Live · 10s refresh
          </span>
        </div>
        <div className="flex items-center gap-2">
          {data?.error && <span className="text-xs text-amber-400">Engine unreachable</span>}
          {data?.fetched_at && <span className="text-xs text-slate-600">{new Date(data.fetched_at).toLocaleTimeString()}</span>}
          <button onClick={() => mutate()} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-400 mb-5">
        Prometheus metrics from the T&T Engine, reshaped into operational charts.
      </p>

      {/* Loading skeleton */}
      {isLoading && !data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {[1,2,3,4].map((i) => <div key={i} className="h-24 rounded-xl border border-slate-700 bg-slate-800/50 animate-pulse" />)}
        </div>
      )}

      {/* Summary cards */}
      {s && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <SummaryCard
            icon={<TrendingUp className="w-3.5 h-3.5" />}
            label="Total Requests"
            value={s.totalRequests.toLocaleString()}
            sub={`${s.totalTokensCreated.toLocaleString()} tokens created`}
          />
          <SummaryCard
            icon={<AlertCircle className="w-3.5 h-3.5" />}
            label="Error Rate"
            value={`${s.errorRate}%`}
            sub={`${s.totalErrors} total errors`}
            accent={parseFloat(s.errorRate) > 1 ? "text-red-400" : "text-white"}
          />
          <SummaryCard
            icon={<Zap className="w-3.5 h-3.5" />}
            label="Cache Hit Rate"
            value={`${s.cacheHitPct}%`}
            sub="SLO ≥ 80%"
            accent={s.cacheHitPct >= 80 ? "text-white" : s.cacheHitPct >= 60 ? "text-yellow-400" : "text-red-400"}
          />
          <SummaryCard
            icon={<ShieldCheck className="w-3.5 h-3.5" />}
            label="Vault Status"
            value={s.vaultSealed ? "SEALED" : "Healthy"}
            sub={`Audit buffer: ${s.auditBufferSize}`}
            accent={s.vaultSealed ? "text-red-400" : "text-emerald-400"}
          />
        </div>
      )}

      {/* Charts grid */}
      {data && !data.error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* Request breakdown by endpoint */}
          <ChartCard title="Request Breakdown by Endpoint" icon={<TrendingUp className="w-3.5 h-3.5 text-indigo-400" />}>
            {data.requestBreakdown.length === 0 ? <EmptyChart /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.requestBreakdown} margin={{ top: 4, right: 4, left: -20, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#64748b" }} angle={-35} textAnchor="end" />
                  <YAxis tick={{ fontSize: 9, fill: "#64748b" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="total"  name="Total"  fill={BAR_PRIMARY} radius={[3,3,0,0]} />
                  <Bar dataKey="errors" name="Errors" fill={BAR_ERROR}   radius={[3,3,0,0]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* Error breakdown pie */}
          <ChartCard title="Error Breakdown by Source" icon={<AlertCircle className="w-3.5 h-3.5 text-red-400" />}>
            {data.errorBreakdown.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-emerald-400 gap-2">
                <ShieldCheck className="w-8 h-8" />
                <p className="text-sm font-medium">No errors recorded</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={data.errorBreakdown} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={{ stroke: "#475569" }}>
                    {data.errorBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* Token transformation breakdown */}
          <ChartCard title="Token Operations Breakdown" icon={<Database className="w-3.5 h-3.5 text-emerald-400" />}>
            {data.transformBreakdown.length === 0 ? <EmptyChart /> : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={data.transformBreakdown} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={80} label={({ name, value }) => `${name}: ${value.toLocaleString()}`} labelLine={{ stroke: "#475569" }}>
                    {data.transformBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* Request latency histogram */}
          <ChartCard title="HTTP Request Latency Distribution" icon={<Zap className="w-3.5 h-3.5 text-yellow-400" />}>
            {data.latencyBuckets.length === 0 ? <EmptyChart /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.latencyBuckets} margin={{ top: 4, right: 4, left: -20, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: "#64748b" }} angle={-35} textAnchor="end" />
                  <YAxis tick={{ fontSize: 9, fill: "#64748b" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Requests" fill={BAR_LATENCY} radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* Crypto operations */}
          {data.cryptoOps.length > 0 && (
            <ChartCard title="Crypto Operations by Type" icon={<ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.cryptoOps} layout="vertical" margin={{ top: 4, right: 20, left: 40, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9, fill: "#64748b" }} />
                  <YAxis dataKey="operation" type="category" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Count" fill={BAR_CRYPTO} radius={[0,3,3,0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Audit health */}
          {s && (
            <ChartCard title="Audit Writer Health" icon={<Database className="w-3.5 h-3.5 text-blue-400" />}>
              <div className="grid grid-cols-2 gap-4 py-4">
                <div className="text-center">
                  <p className="text-3xl font-mono font-bold text-white">{s.auditBufferSize}</p>
                  <p className="text-xs text-slate-500 mt-1">Buffer entries (in-memory)</p>
                  <div className={clsx("text-xs mt-1 font-medium", s.auditBufferSize > 100 ? "text-amber-400" : "text-emerald-400")}>
                    {s.auditBufferSize > 100 ? "High — check flush" : "Normal"}
                  </div>
                </div>
                <div className="text-center">
                  <p className={clsx("text-3xl font-mono font-bold", s.auditDlqBytes > 0 ? "text-red-400" : "text-white")}>
                    {s.auditDlqBytes > 0 ? `${(s.auditDlqBytes / 1024).toFixed(1)}KB` : "0 B"}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Dead letter queue size</p>
                  <div className={clsx("text-xs mt-1 font-medium", s.auditDlqBytes > 0 ? "text-red-400" : "text-emerald-400")}>
                    {s.auditDlqBytes > 0 ? "DLQ has entries — replay needed" : "Empty"}
                  </div>
                </div>
              </div>
            </ChartCard>
          )}
        </div>
      )}

      {/* Engine error state */}
      {data?.error && (
        <div className="flex items-center gap-3 p-5 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-300 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>T&T Engine is unreachable: <span className="font-mono">{data.error}</span>. Charts will appear when the engine comes back online.</span>
        </div>
      )}

      <p className="text-xs text-slate-600 mt-4 text-right">
        Data from T&T Engine Prometheus endpoint · auto-refreshes every 10s
      </p>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

function ChartCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <span className="text-sm font-medium text-slate-300">{title}</span>
      </div>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex items-center justify-center h-48 text-slate-600 text-sm">
      No data yet — metrics appear after engine activity
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 6,
  fontSize: 11,
};
