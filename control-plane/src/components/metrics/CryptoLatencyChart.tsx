"use client";

// MetricsPanel — Live metrics dashboard with recharts time-series.
// Replaces the old 3-card static panel.
//
// SLO thresholds (from T&T Engine metrics.py):
//   Crypto latency P99: 200ms
//   Cache hit rate:      80%
//   Error rate:          1%

import { useMetrics } from "@/lib/api";
import {
  Activity, Hash, AlertCircle, Database,
  Zap, TrendingUp, RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

// ── SLO thresholds ─────────────────────────────────────────────────
const SLO_LATENCY_MS  = 200;
const SLO_CACHE_PCT   = 80;

// ── Extended MetricsData shape returned by updated /api/metrics ────
interface ExtMetricsData {
  crypto_latency:          { time: string; value: number }[];
  token_throughput:        { time: string; value: number }[];
  error_rate:              { time: string; value: number }[];
  db_connections_history:  { time: string; value: number }[];
  cache_hit_rate:          number;
  total_tokens_created:    number;
  active_connections:      number;
  total_errors:            number;
  crypto_latency_avg_ms:   number;
  slo:                     { latency_ok: boolean; cache_ok: boolean };
  error?:                  string;
  fetched_at:              string;
}

// ── Helpers ────────────────────────────────────────────────────────

function SloTag({ ok }: { ok: boolean }) {
  return (
    <span className={clsx(
      "text-[10px] px-1.5 py-0.5 rounded font-medium",
      ok ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400",
    )}>
      {ok ? "SLO ✓" : "SLO ✗"}
    </span>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  sloOk?: boolean;
  accent?: string;
}

function StatCard({ icon, label, value, sub, sloOk, accent = "text-white" }: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between text-slate-400 mb-1">
        <div className="flex items-center gap-1.5 text-xs">{icon}<span>{label}</span></div>
        {sloOk !== undefined && <SloTag ok={sloOk} />}
      </div>
      <p className={clsx("text-2xl font-mono font-bold", accent)}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

interface MiniChartProps {
  data: { time: string; value: number }[];
  color: string;
  label: string;
  type?: "area" | "line";
}

function MiniChart({ data, color, label, type = "area" }: MiniChartProps) {
  if (!data || data.length < 2) {
    return (
      <div className="flex items-center justify-center h-24 text-xs text-slate-600">
        Waiting for data…
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-slate-500 mb-2">{label}</p>
      <ResponsiveContainer width="100%" height={80}>
        {type === "area" ? (
          <AreaChart data={data} margin={{ top: 2, right: 4, left: -30, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: "#94a3b8" }}
              itemStyle={{ color: "#e2e8f0" }}
            />
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5}
              fill={`url(#grad-${color.replace("#", "")})`} dot={false} />
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 2, right: 4, left: -30, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: "#94a3b8" }}
              itemStyle={{ color: "#e2e8f0" }}
            />
            <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} dot={false} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function CacheGauge({ pct }: { pct: number }) {
  const ok = pct >= SLO_CACHE_PCT;
  const color = ok ? "#22c55e" : pct >= 60 ? "#eab308" : "#ef4444";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-slate-500">Cache Hit Rate</span>
        <SloTag ok={ok} />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-slate-700 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
          />
        </div>
        <span className="font-mono text-sm font-bold text-white w-12 text-right">{pct}%</span>
      </div>
      <p className="text-[10px] text-slate-600 mt-1">SLO threshold: ≥{SLO_CACHE_PCT}%</p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

export default function MetricsPanel() {
  const { data: raw, isLoading, mutate } = useMetrics();
  const data = raw as unknown as ExtMetricsData | undefined;

  const latestTokens    = data?.total_tokens_created ?? 0;
  const latencyMs       = data?.crypto_latency_avg_ms ?? 0;
  const totalErrors     = data?.total_errors ?? 0;
  const cacheHit        = data?.cache_hit_rate ?? 0;
  const dbConns         = data?.active_connections ?? 0;
  const latencyOk       = data?.slo?.latency_ok ?? true;

  const latencyAccent = latencyOk ? "text-white" : latencyMs < SLO_LATENCY_MS * 1.5 ? "text-yellow-400" : "text-red-400";
  const errAccent     = totalErrors === 0 ? "text-white" : "text-red-400";

  // Compute delta tokens since previous data point (rate indicator)
  const history = data?.token_throughput ?? [];
  const throughputDelta = history.length >= 2
    ? Math.max(0, history[history.length - 1].value - history[history.length - 2].value)
    : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white">Live Metrics</h2>
        <div className="flex items-center gap-2">
          {data?.error && (
            <span className="text-xs text-amber-400">Engine unreachable — showing cached data</span>
          )}
          <button
            onClick={() => mutate()}
            className="p-1.5 rounded text-slate-500 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading && !data && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/50 h-24 animate-pulse" />
          ))}
        </div>
      )}

      {/* Stat cards row */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
          <StatCard
            icon={<Hash className="w-3.5 h-3.5" />}
            label="Tokens Created"
            value={latestTokens.toLocaleString()}
            sub={throughputDelta > 0 ? `+${throughputDelta} since last poll` : "no new since last poll"}
          />
          <StatCard
            icon={<Activity className="w-3.5 h-3.5" />}
            label="Crypto Latency"
            value={latencyMs > 0 ? `${latencyMs.toFixed(1)}ms` : "N/A"}
            sub={`SLO: <${SLO_LATENCY_MS}ms`}
            sloOk={latencyOk}
            accent={latencyAccent}
          />
          <StatCard
            icon={<AlertCircle className="w-3.5 h-3.5" />}
            label="Total Errors"
            value={totalErrors.toLocaleString()}
            sub="crypto + db + http 5xx"
            accent={errAccent}
          />
          <StatCard
            icon={<Zap className="w-3.5 h-3.5" />}
            label="Cache Hit Rate"
            value={`${cacheHit}%`}
            sub={`SLO: ≥${SLO_CACHE_PCT}%`}
            sloOk={cacheHit >= SLO_CACHE_PCT || cacheHit === 0}
            accent={cacheHit >= SLO_CACHE_PCT || cacheHit === 0 ? "text-white" : cacheHit >= 60 ? "text-yellow-400" : "text-red-400"}
          />
          <StatCard
            icon={<Database className="w-3.5 h-3.5" />}
            label="DB Connections"
            value={dbConns > 0 ? String(dbConns) : "—"}
            sub="write + read pool"
          />
        </div>
      )}

      {/* Charts row */}
      {data && (data.token_throughput?.length >= 2 || data.crypto_latency?.length >= 2) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Token throughput area chart */}
          <div className="lg:col-span-2 rounded-xl border border-slate-700 bg-slate-800/50 p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-xs font-medium text-slate-300">Token Throughput</span>
              <span className="text-[10px] text-slate-600">cumulative · last {data.token_throughput.length} polls</span>
            </div>
            <MiniChart
              data={data.token_throughput}
              color="#34d399"
              label=""
              type="area"
            />
          </div>

          {/* Crypto latency + cache hit */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 flex flex-col gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Activity className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs font-medium text-slate-300">Crypto Latency (avg ms)</span>
              </div>
              <MiniChart
                data={data.crypto_latency}
                color={latencyOk ? "#60a5fa" : "#f87171"}
                label=""
                type="line"
              />
            </div>
            <CacheGauge pct={cacheHit} />
          </div>
        </div>
      )}

      {/* Fallback when no history yet */}
      {data && data.token_throughput?.length < 2 && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4 text-center text-xs text-slate-600">
          Charts appear after 2+ data points. Refreshes every 15s.
        </div>
      )}
    </div>
  );
}
